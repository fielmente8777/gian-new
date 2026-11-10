import { z } from "zod";

import { BaseDto } from "../../../shared/http/base-dto.js";

/** Facebook page ids are digits. */
const pageId = z
  .string()
  .trim()
  .regex(/^\d{5,25}$/, "Invalid page id");
const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");

export class MetaPageParamsDto extends BaseDto {
  static override readonly schema = z.object({ pageId });
}
export type MetaPageParams = z.infer<typeof MetaPageParamsDto.schema>;

export class MetaConnectionParamsDto extends BaseDto {
  static override readonly schema = z.object({ connectionId: objectId });
}
export type MetaConnectionParams = z.infer<typeof MetaConnectionParamsDto.schema>;

export class LinkMetaPageDto extends BaseDto {
  static override readonly schema = z.object({
    ndid: z.string().trim().min(1).max(64).meta({ description: "the client" }),
    hid: z.string().trim().min(1).max(32).meta({ description: "one of its properties" }),
  });
}
export type LinkMetaPageBody = z.infer<typeof LinkMetaPageDto.schema>;

const loose = (description: string) => z.looseObject({}).meta({ description });
export const metaPagesOverviewSchema = loose(
  "pages (pageId, name, link with hotelName/propertyName, conflict, connections), connections, counts",
);
export const metaPageSchema = loose("the page after the change, with every copy's link");
export const metaSyncResultSchema = loose("returned, added, updated, missing, subscribeFailed");
