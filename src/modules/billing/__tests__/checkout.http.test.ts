import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

import { App } from "../../../app.js";
import { EventBus } from "../../../shared/events/event-bus.js";
import { AuthModule } from "../../auth/auth.module.js";
import { LegacyTokenService } from "../../auth/services/legacy-token.service.js";
import { FakeGoogle, InMemoryCredentials, InMemoryRefreshTokens, InMemoryUsers, testConfig } from "../../auth/__tests__/fakes.js";
import { BillingModule } from "../billing.module.js";
import {
  FakeBillingMailbox,
  FakeGateway,
  InMemoryBillingDetails,
  InMemoryCatalogue,
  InMemoryInvoices,
  InMemoryOffers,
  InMemoryPayments,
  InMemorySubscriptionBilling,
  KEY_SECRET,
  offerInput,
  planByCode,
  sign,
  silentLogger,
  testHotel,
  WEBHOOK_SECRET,
} from "./fakes.js";

// The real App + AuthModule + BillingModule over HTTP; Razorpay and MongoDB are in-memory fakes.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (res: Response): Promise<any> => res.json();
const DAY = 86_400_000;
const PRO = planByCode("PRO");

describe("billing checkout", () => {
  let base: string;
  let close: () => void;
  let ownerToken: string;
  let memberToken: string;
  let ndid: string;
  const users = new InMemoryUsers();
  const subscriptions = new InMemorySubscriptionBilling();
  const payments = new InMemoryPayments();
  const offers = new InMemoryOffers();
  const catalogue = new InMemoryCatalogue();
  const gateway = new FakeGateway();
  const mailbox = new FakeBillingMailbox();
  const invoices = new InMemoryInvoices();
  const activated: string[] = [];

  const call = (method: string, path: string, token: string | null, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
  const pay = async (body: Record<string, unknown>) => {
    const started = await json(await call("POST", "/api/v1/billing/checkout", ownerToken, body));
    assert.equal(started.data.status, "pending", JSON.stringify(started));
    const orderId = started.data.orderId as string;
    const paymentId = `pay_${orderId}`;
    const confirmed = await call("POST", "/api/v1/billing/checkout/confirm", ownerToken, {
      razorpay_order_id: orderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: sign(KEY_SECRET, `${orderId}|${paymentId}`),
    });
    assert.equal(confirmed.status, 200);
    return { started: started.data, confirmed: (await json(confirmed)).data, orderId, paymentId };
  };
  const webhook = (body: unknown, signature?: string) => {
    const raw = JSON.stringify(body);
    return call("POST", "/api/v1/billing/webhooks/razorpay", null, raw, {
      "x-razorpay-signature": signature ?? sign(WEBHOOK_SECRET, raw),
    });
  };

  before(async () => {
    const config = testConfig();
    const owner = users.add({ email: "owner@hotel.test", isAdmin: true });
    ndid = owner.ndid!;
    users.add({ email: "frontdesk@hotel.test", isAdmin: false, ndid });
    subscriptions.addTrial(ndid, 5);

    const events = new EventBus(silentLogger);
    const auth = new AuthModule({
      config: config.auth,
      logger: silentLogger,
      events,
      users,
      overrides: { credentials: new InMemoryCredentials(), refreshTokens: new InMemoryRefreshTokens(), google: new FakeGoogle() },
    });
    const billing = new BillingModule({
      logger: silentLogger,
      mailer: mailbox,
      razorpay: {},
      auth: auth.authenticate,
      subscriptions,
      afterActivation: async (id) => {
        activated.push(id);
      },
      recipients: async () => ({ to: ["owner@hotel.test"], hotelName: "Hotel Test" }),
      hotel: testHotel,
      overrides: { catalogue, offers, payments, gateway, invoices, billingDetails: new InMemoryBillingDetails() },
    });
    const server = new App({ config: config.app, logger: silentLogger, modules: [auth, billing] }).express.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
    const legacy = new LegacyTokenService(config.auth);
    ownerToken = await legacy.sign("owner@hotel.test");
    memberToken = await legacy.sign("frontdesk@hotel.test");
  });
  after(() => close());

  it("serves the public catalogue without a token: no trial plan, no inactive apps", async () => {
    const body = await json(await call("GET", "/api/v1/billing/catalogue", null));
    const codes = body.data.plans.map((p: { code: string }) => p.code);
    assert.deepEqual(codes.sort(), ["BASIC", "ENTERPRISE", "PRO"]);
    assert.ok(!body.data.apps.some((a: { code: string }) => a.code === "grm"));
    assert.equal(body.data.settings.cycles.length, 4);
  });

  it("shows a trial hotel its phase, everything on, and what it can buy", async () => {
    const body = await json(await call("GET", "/api/v1/billing/account", ownerToken));
    assert.equal(body.data.phase, "trial");
    assert.equal(body.data.subscription.planName, "Free trial");
    assert.equal(body.data.current, null);
    assert.ok(body.data.entitlements.apps.includes("exotel"));
    assert.equal(body.data.canPay, true);
  });

  it("quotes on the server: a trial hotel's purchase is new and starts today", async () => {
    const res = await call("POST", "/api/v1/billing/quote", ownerToken, { planId: PRO.id, cycleMonths: 12, addonCodes: ["exotel"] });
    const q = (await json(res)).data;
    assert.equal(q.kind, "new");
    assert.deepEqual(q.addonCodes, ["exotel"]);
    // (999 + 1000) × 12 = 23,988; −30% = 16,791.60; +18% GST = 19,814.09
    assert.equal(q.totalPaise, 1_981_409);
  });

  it("refuses contact-sales plans, team members and a changed price", async () => {
    const enterprise = await call("POST", "/api/v1/billing/checkout", ownerToken, { planId: planByCode("ENTERPRISE").id, cycleMonths: 12 });
    assert.equal((await json(enterprise)).error.code, "PLAN_NOT_AVAILABLE");
    const member = await call("POST", "/api/v1/billing/checkout", memberToken, { planId: PRO.id, cycleMonths: 12 });
    assert.equal(member.status, 403);
    assert.equal((await json(member)).error.code, "BILLING_OWNER_ONLY");
    const stale = await call("POST", "/api/v1/billing/checkout", ownerToken, { planId: PRO.id, cycleMonths: 12, expectedTotalPaise: 1 });
    assert.equal((await json(stale)).error.code, "PRICE_CHANGED");
  });

  it("keeps the hotel's GST details for its invoices", async () => {
    const before = (await json(await call("GET", "/api/v1/billing/details", ownerToken))).data;
    assert.equal(before.legalName, "Hotel Test", "defaults from the profile");
    assert.equal(before.state, "Rajasthan");
    const bad = await call("PUT", "/api/v1/billing/details", ownerToken, { legalName: "X", gstin: "123" });
    assert.equal(bad.status, 400);
    assert.equal((await call("PUT", "/api/v1/billing/details", memberToken, { legalName: "X" })).status, 403);
    const saved = await call("PUT", "/api/v1/billing/details", ownerToken, {
      legalName: "Hotel Test Pvt Ltd",
      gstin: "08aaach1234k1z2",
      address: "MG Road",
      city: "Jaipur",
      state: "Rajasthan",
      pinCode: "302001",
      email: "accounts@hotel.test",
    });
    assert.equal((await json(saved)).data.gstin, "08AAACH1234K1Z2");
  });

  it("rejects a forged payment signature", async () => {
    const started = (await json(await call("POST", "/api/v1/billing/checkout", ownerToken, { planId: PRO.id, cycleMonths: 1 }))).data;
    const res = await call("POST", "/api/v1/billing/checkout/confirm", ownerToken, {
      razorpay_order_id: started.orderId,
      razorpay_payment_id: "pay_x",
      razorpay_signature: "forged",
    });
    assert.equal((await json(res)).error.code, "PAYMENT_SIGNATURE_INVALID");
    assert.equal((await payments.findByOrderId(started.orderId))?.status, "created");
  });

  it("applies a paid order once: only the plan's apps and add-ons stay on, held leads are released, a receipt goes out", async () => {
    const { started, confirmed, orderId, paymentId } = await pay({ planId: PRO.id, cycleMonths: 12, addonCodes: ["exotel"] });
    assert.equal(started.amountPaise, 1_981_409);
    assert.equal(gateway.orders.at(-1)?.amount, 1_981_409, "Razorpay gets the server's amount");
    assert.equal(confirmed.account.phase, "active");
    assert.deepEqual(confirmed.account.entitlements.apps.sort(), ["eazbot", "exotel", "lead_management", "whatsapp"]);

    const sub = (await subscriptions.snapshot(ndid))!;
    assert.equal(sub.appAccess.grm, false, "an app not bought is switched off after the trial");
    assert.equal(sub.appAccess.cms, true);
    assert.equal(sub.billing?.planCode, "PRO");
    assert.equal(Math.round((sub.endDate.getTime() - Date.now()) / DAY / 30), 12);
    assert.deepEqual(activated, [ndid]);
    assert.equal(mailbox.sent.length, 1);
    assert.match(mailbox.sent[0]!.text, /₹19,814\.09/);

    // the webhook for the same payment, and a repeated browser call, change nothing
    const again = await webhook({ event: "payment.captured", payload: { payment: { entity: { id: paymentId, order_id: orderId, amount: 1_981_409, method: "upi" } } } });
    assert.equal(again.status, 200);
    await call("POST", "/api/v1/billing/checkout/confirm", ownerToken, {
      razorpay_order_id: orderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: sign(KEY_SECRET, `${orderId}|${paymentId}`),
    });
    assert.equal(activated.length, 1);
    assert.equal(mailbox.sent.length, 1);
  });

  it("prices the same choice as a renewal from the current end, and a different one as a change with credit", async () => {
    const sub = (await subscriptions.snapshot(ndid))!;
    const renew = (await json(await call("POST", "/api/v1/billing/quote", ownerToken, { planId: PRO.id, cycleMonths: 12, addonCodes: ["exotel"] }))).data;
    assert.equal(renew.kind, "renew");
    assert.equal(renew.periodStart, sub.endDate.toISOString());
    assert.equal(renew.creditPaise, 0);

    const change = (await json(await call("POST", "/api/v1/billing/quote", ownerToken, { planId: PRO.id, cycleMonths: 12, addonCodes: [] }))).data;
    assert.equal(change.kind, "change");
    assert.equal(change.creditPaise, 839_160, "the credit pays the whole new year (PRO yearly without the add-on)");
    assert.equal(change.totalPaise, 0, "dropping an add-on is fully covered by the credit");
    assert.ok(change.bonusDays > 300, `the rest of the credit becomes extra days, never lost (${change.bonusDays})`);
  });

  it("applies offers the server checks, and counts each use", async () => {
    await offers.create(offerInput("WELCOME20", { value: 20, kinds: ["renew"] }), new Date());
    const ok = (await json(await call("POST", "/api/v1/billing/quote", ownerToken, { planId: PRO.id, cycleMonths: 12, addonCodes: ["exotel"], offerCode: "welcome20" }))).data;
    assert.equal(ok.offer.code, "WELCOME20");
    assert.equal(ok.offerError, null);
    const wrongKind = (await json(await call("POST", "/api/v1/billing/quote", ownerToken, { planId: PRO.id, cycleMonths: 1, offerCode: "WELCOME20" }))).data;
    assert.match(wrongKind.offerError, /renewals only/);
    const refused = await call("POST", "/api/v1/billing/checkout", ownerToken, { planId: PRO.id, cycleMonths: 1, offerCode: "WELCOME20" });
    assert.equal((await json(refused)).error.code, "OFFER_INVALID");

    const before = (await subscriptions.snapshot(ndid))!.endDate;
    await pay({ planId: PRO.id, cycleMonths: 12, addonCodes: ["exotel"], offerCode: "WELCOME20" });
    const after = (await subscriptions.snapshot(ndid))!.endDate;
    assert.equal(Math.round((after.getTime() - before.getTime()) / DAY / 30), 12, "a renewal adds to the current end");
    assert.equal((await offers.byCode("WELCOME20"))?.redemptions, 1);
    const second = (await json(await call("POST", "/api/v1/billing/quote", ownerToken, { planId: PRO.id, cycleMonths: 12, addonCodes: ["exotel"], offerCode: "WELCOME20" }))).data;
    assert.match(second.offerError, /already used/);
  });

  it("sets up auto-renew, renews on each charge exactly once, and turns it off", async () => {
    const on = (await json(await call("POST", "/api/v1/billing/auto-renew", ownerToken, { enabled: true }))).data;
    assert.equal(on.status, "authorize");
    const sub = (await subscriptions.snapshot(ndid))!;
    assert.equal(gateway.subscriptions.at(-1)?.startAt?.getTime(), sub.endDate.getTime(), "first charge at the current end");
    assert.equal(gateway.plans.at(-1)?.amountPaise, 1_981_409);
    assert.equal(sub.autoRenewal?.status, "pending");

    const paymentId = "pay_auth_1";
    const confirmed = await call("POST", "/api/v1/billing/auto-renew/confirm", ownerToken, {
      razorpay_subscription_id: on.subscriptionId,
      razorpay_payment_id: paymentId,
      razorpay_signature: sign(KEY_SECRET, `${paymentId}|${on.subscriptionId}`),
    });
    assert.equal((await json(confirmed)).data.subscription.autoRenew, true);

    const charge = {
      event: "subscription.charged",
      payload: {
        subscription: { entity: { id: on.subscriptionId, notes: { ndid } } },
        payment: { entity: { id: "pay_renew_1", order_id: "order_renew_1", amount: 1_981_409, method: "card" } },
      },
    };
    const endBefore = sub.endDate.getTime();
    assert.equal((await webhook(charge)).status, 200);
    assert.equal((await webhook(charge)).status, 200, "Razorpay retries are ignored");
    const renewed = (await subscriptions.snapshot(ndid))!;
    assert.equal(Math.round((renewed.endDate.getTime() - endBefore) / DAY / 30), 12);
    assert.equal(payments.rows.filter((p) => p.kind === "auto_renew").length, 1);
    assert.match(mailbox.sent.at(-1)!.text, /renewed automatically/);

    const off = (await json(await call("POST", "/api/v1/billing/auto-renew", ownerToken, { enabled: false }))).data;
    assert.equal(off.account.subscription.autoRenew, false);
    assert.equal(gateway.subscriptions.at(-1)?.cancelled, true);
  });

  it("issues a GST invoice for each paid payment, emails it as a PDF and lets only this hotel download it", async () => {
    const account = (await json(await call("GET", "/api/v1/billing/account", ownerToken))).data;
    const paid = account.payments.filter((p: { status: string }) => p.status === "SUCCESS");
    assert.ok(paid.length >= 2);
    assert.ok(paid.every((p: { invoice: { number: string } | null }) => /^EZ\/\d{2}-\d{2}\/\d{5}$/.test(p.invoice?.number ?? "")));
    const numbers = new Set(paid.map((p: { invoice: { number: string } }) => p.invoice.number));
    assert.equal(numbers.size, paid.length, "every invoice has its own number");

    const receipt = mailbox.sent.find((m) => m.attachments?.length);
    assert.ok(receipt, "a receipt carried the PDF");
    assert.equal(receipt!.attachments![0]!.contentType, "application/pdf");
    assert.ok(receipt!.attachments![0]!.content.toString("latin1").startsWith("%PDF"));
    assert.match(receipt!.text, /Invoice: EZ\//);

    const id = paid[0].invoice.id;
    const pdf = await call("GET", `/api/v1/billing/invoices/${id}/pdf`, ownerToken);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get("content-type"), "application/pdf");
    assert.match(pdf.headers.get("content-disposition") ?? "", /attachment; filename="Eazotel-invoice-EZ-/);
    assert.ok(Buffer.from(await pdf.arrayBuffer()).toString("latin1").startsWith("%PDF"));

    assert.equal(invoices.rows[0]!.buyer.name, "Hotel Test Pvt Ltd", "the hotel's GST details are on it");
    assert.equal(invoices.rows[0]!.buyer.gstin, "08AAACH1234K1Z2");
    assert.equal(invoices.rows[0]!.taxes[0]!.label, "IGST", "Eazotel's state isn't set in the test settings");

    const other = users.add({ email: "other@hotel.test", isAdmin: true });
    const otherToken = await new LegacyTokenService(testConfig().auth).sign(other.email);
    assert.equal((await call("GET", `/api/v1/billing/invoices/${id}/pdf`, otherToken)).status, 404);
  });

  it("rejects a webhook with a bad signature", async () => {
    const res = await webhook({ event: "payment.captured" }, "nope");
    assert.equal((await json(res)).error.code, "WEBHOOK_SIGNATURE_INVALID");
  });
});
