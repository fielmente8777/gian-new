import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { planByCode, TestBillingPort } from "./fakes.js";
import { TEST_ZOHO_WEBHOOK_TOKEN } from "./zoho-fakes.js";

const owner = { ndid: "hotel-1", email: "owner@hotel.test", isAdmin: true, staffEmail: null };
const PRO = planByCode("PRO");
const pro12 = { planId: PRO.id, cycleMonths: 12, addonCodes: [], seats: 0, offerCode: null };

describe("Zoho Books: connection, invoices and payments", () => {
  let t: ReturnType<typeof TestBillingPort.create>;

  const connect = async () => {
    const url = await t.port.zoho.connection.startConnect("boss@eazotel.com");
    const state = new URL(url).searchParams.get("state")!;
    return t.port.zoho.connection.finishConnect("good-code", state, undefined);
  };

  beforeEach(() => {
    t = TestBillingPort.create();
    t.subscriptions.addTrial(owner.ndid, 5);
  });

  describe("connecting", () => {
    it("connects through Zoho's sign-in, keeps the refresh token encrypted and goes back to the console", async () => {
      const back = await connect();
      assert.equal(back, "https://admin.eazotel.test/billing/zoho?zoho=connected");
      const status = await t.port.zoho.connection.status();
      assert.equal(status.connected, true);
      assert.equal(status.orgName, "Eazotel Technologies");
      assert.equal(status.redirectUri, "https://api.eazotel.test/api/v1/billing/zoho/callback");
      assert.equal(status.payment.provider, "razorpay", "connecting alone never moves payments");
      assert.ok(t.zohoStore.conn?.refreshTokenEnc.startsWith("v1."));
      assert.ok(
        !t.zohoStore.conn?.refreshTokenEnc.includes("refresh-secret"),
        "the token is never stored in the clear",
      );
    });

    it("refuses a callback whose state it didn't make, or one used twice", async () => {
      assert.match(await t.port.zoho.connection.finishConnect("good-code", "forged", undefined), /zoho=expired/);
      const url = await t.port.zoho.connection.startConnect("boss@eazotel.com");
      const state = new URL(url).searchParams.get("state")!;
      assert.match(await t.port.zoho.connection.finishConnect("good-code", state, undefined), /connected/);
      assert.match(await t.port.zoho.connection.finishConnect("good-code", state, undefined), /expired/);
      assert.match(await t.port.zoho.connection.finishConnect(undefined, undefined, "access_denied"), /denied/);
    });

    it("won't switch payments to Zoho before it is connected", async () => {
      await assert.rejects(t.port.zoho.connection.setProvider("zoho", "boss@eazotel.com"), {
        code: "ZOHO_NOT_CONNECTED",
      });
    });

    it("disconnecting while on Zoho puts payments back on Razorpay", async () => {
      await connect();
      await t.port.zoho.connection.setProvider("zoho", "boss@eazotel.com");
      const setup = await t.port.zoho.connection.disconnect();
      assert.equal(setup.provider, "razorpay");
      assert.deepEqual(t.zoho.revoked, ["refresh-secret"]);
      assert.equal((await t.port.zoho.connection.status()).connected, false);
    });
  });

  describe("paying by Zoho invoice", () => {
    beforeEach(async () => {
      await connect();
      await t.port.zoho.connection.setTax("tax-18");
      await t.port.zoho.connection.setProvider("zoho", "boss@eazotel.com");
    });

    it("the dashboard's pay button makes a Zoho invoice at our price, with GST, for a new Zoho customer", async () => {
      const quote = await t.port.checkout.quote(owner, pro12);
      const start = await t.port.checkout.start(owner, { ...pro12, autoRenew: false });
      assert.equal(start.status, "invoice");
      if (start.status !== "invoice") return;
      assert.match(start.invoiceUrl ?? "", /^https:\/\/books\.zoho\.test\/portal\/invoice\//);
      assert.equal(start.totalPaise, quote.totalPaise, "the hotel pays exactly what the plans page showed");

      const [made] = t.zoho.created;
      assert.equal(made!.referenceNumber, start.orderId);
      assert.ok(made!.lineItems.every((l) => l.taxId === "tax-18"));
      assert.equal(made!.discount, (quote.grossPaise - quote.taxablePaise) / 100, "the 12-month discount, before tax");

      assert.equal(
        (await t.zohoStore.linkByNdid(owner.ndid))?.contactName,
        "Hotel Test",
        "made from the profile, and linked",
      );
      assert.equal((await t.payments.findByOrderId(start.orderId))?.method, "zoho");

      const account = await t.port.checkout.account(owner);
      assert.equal(account.paymentProvider, "zoho");
      assert.equal(account.paymentsReady, true);
      assert.equal(account.autoRenewReady, false, "auto-renew stays a Razorpay mandate");
    });

    it("renews the plan once Zoho says it's paid, once, and without a second invoice of ours", async () => {
      const start = await t.port.checkout.start(owner, { ...pro12, autoRenew: false });
      if (start.status !== "invoice") throw new Error("expected an invoice");
      await assert.rejects(t.port.zoho.sync.handleWebhook("wrong", { invoice_id: start.invoiceId }), {
        code: "WEBHOOK_SIGNATURE_INVALID",
      });

      // not paid yet: the webhook changes nothing
      await t.port.zoho.sync.handleWebhook(TEST_ZOHO_WEBHOOK_TOKEN, { invoice_id: start.invoiceId });
      assert.equal(t.activated.length, 0);

      t.zoho.pay(start.invoiceId);
      await t.port.zoho.sync.handleWebhook(TEST_ZOHO_WEBHOOK_TOKEN, {
        JSONString: JSON.stringify({ invoice: { invoice_id: start.invoiceId } }),
      });
      await t.port.zoho.sync.handleWebhook(TEST_ZOHO_WEBHOOK_TOKEN, { invoice_id: start.invoiceId });
      assert.deepEqual(t.activated, [owner.ndid], "applied exactly once");
      assert.equal((await t.subscriptions.snapshot(owner.ndid))?.planId, PRO.id);
      assert.ok((await t.payments.findByOrderId(start.orderId))?.appliedAt);
      assert.equal(t.invoiceStore.rows.length, 0, "Zoho's invoice is the GST invoice");

      const account = await t.port.checkout.account(owner);
      assert.equal(account.payments[0]?.zohoInvoice?.number, (await t.zohoStore.invoice(start.invoiceId))?.number);
    });

    it("the 30-minute check applies a paid invoice the webhook missed", async () => {
      const start = await t.port.checkout.start(owner, { ...pro12, autoRenew: false });
      if (start.status !== "invoice") throw new Error("expected an invoice");
      t.zoho.pay(start.invoiceId);
      const summary = await t.port.zoho.sync.syncRecent();
      assert.equal(summary.applied, 1);
      assert.deepEqual(t.activated, [owner.ndid]);
      assert.equal((await t.port.zoho.sync.syncRecent()).applied, 0, "nothing twice");
    });

    it("auto-renew can't be switched on while hotels pay by Zoho invoice", async () => {
      // the account must look paid first; activate a period directly
      await t.subscriptions.activate(owner.ndid, {
        planId: PRO.id,
        startDate: new Date(),
        endDate: new Date(Date.now() + 60 * 86_400_000),
        apps: [],
        appAccess: {},
        billing: null,
      } as never);
      const account = await t.port.checkout.account(owner);
      assert.equal(account.autoRenewReady, false);
    });
  });

  describe("invoices the team makes in Zoho Books", () => {
    beforeEach(async () => {
      await connect();
    });

    it("a paid invoice of a linked customer waits for staff, prefilled; applying renews the client once", async () => {
      const contact = await t.zoho.createContact({ accessToken: "", apiDomain: "" }, "org-1", {
        name: "Green Castle Resort",
        email: null,
        phone: null,
      });
      await t.port.zoho.customers.link(owner.ndid, contact.contactId, "boss@eazotel.com");
      const invoice = t.zoho.addPaidByHand(contact.contactId, 14141.64);

      const summary = await t.port.zoho.sync.syncRecent();
      assert.equal(summary.needsReview, 1);
      const [waiting] = await t.zohoStore.invoices({ state: "review", limit: 10 });
      assert.equal(waiting?.ndid, owner.ndid, "the link says whose it is");
      assert.equal(t.activated.length, 0, "nothing is applied without staff saying which plan");

      const applied = await t.port.zoho.sync.apply(
        invoice.invoiceId,
        { ndid: owner.ndid, planId: PRO.id, cycleMonths: 12, addonCodes: [], seats: 0 },
        "boss@eazotel.com",
      );
      assert.ok(applied.appliedAt);
      assert.deepEqual(t.activated, [owner.ndid]);
      const payment = await t.payments.findByOrderId(`zoho_${invoice.invoiceId}`);
      assert.equal(payment?.amount, 1414164);
      assert.equal(payment?.method, "zoho");

      await t.port.zoho.sync.apply(
        invoice.invoiceId,
        { ndid: owner.ndid, planId: PRO.id, cycleMonths: 12, addonCodes: [], seats: 0 },
        "boss@eazotel.com",
      );
      assert.equal(t.activated.length, 1, "applying again does nothing");
    });

    it("an unlinked customer's invoice gets linked to the client staff pick", async () => {
      const contact = await t.zoho.createContact({ accessToken: "", apiDomain: "" }, "org-1", {
        name: "Midori",
        email: null,
        phone: null,
      });
      const invoice = t.zoho.addPaidByHand(contact.contactId, 5000);
      await t.port.zoho.sync.syncRecent();
      assert.equal((await t.zohoStore.invoice(invoice.invoiceId))?.ndid, null);

      await t.port.zoho.sync.apply(
        invoice.invoiceId,
        { ndid: owner.ndid, planId: PRO.id, cycleMonths: 1, addonCodes: [], seats: 0 },
        "boss@eazotel.com",
      );
      assert.equal(
        (await t.zohoStore.linkByContact(contact.contactId))?.ndid,
        owner.ndid,
        "its next invoice is prefilled",
      );
    });

    it("an invoice that isn't for a subscription can be set aside", async () => {
      const contact = await t.zoho.createContact({ accessToken: "", apiDomain: "" }, "org-1", {
        name: "Website build client",
        email: null,
        phone: null,
      });
      const invoice = t.zoho.addPaidByHand(contact.contactId, 25000, "Website design");
      await t.port.zoho.sync.syncRecent();
      await t.port.zoho.sync.ignore(invoice.invoiceId, "boss@eazotel.com");
      assert.equal((await t.zohoStore.invoices({ state: "review", limit: 10 })).length, 0);
      await assert.rejects(
        t.port.zoho.sync.apply(
          invoice.invoiceId,
          { ndid: owner.ndid, planId: PRO.id, cycleMonths: 1, addonCodes: [], seats: 0 },
          "x",
        ),
        { code: "ZOHO_INVOICE_NOT_APPLICABLE" },
      );
    });

    it("staff can invoice a client through Zoho even while hotels still pay by Razorpay", async () => {
      const staffActor = { ...owner, staffEmail: "sales@eazotel.com" };
      const made = await t.port.checkout.zohoInvoiceForStaff(staffActor, pro12, ["accounts@hotel.test"]);
      assert.equal(made.status, "invoice");
      assert.deepEqual(t.zoho.emailed, [{ invoiceId: made.invoiceId, to: ["accounts@hotel.test"] }], "Zoho emails it");
      assert.equal((await t.port.checkout.account(owner)).paymentProvider, "razorpay");
    });
  });
});
