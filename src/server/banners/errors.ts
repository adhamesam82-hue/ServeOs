import { DomainError, type Locale } from "@/shared/errors";

export class BannerNotFoundError extends DomainError {
  readonly code = "banner_not_found";
  constructor() {
    super("Banner not found");
    this.name = "BannerNotFoundError";
  }
  messageFor(locale: Locale): string {
    return locale === "ar" ? "اللافتة غير موجودة" : "Banner not found";
  }
}
