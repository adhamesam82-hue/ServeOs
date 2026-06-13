import { NextResponse, type NextRequest } from "next/server";
import { classifyHost } from "./middleware-routing";

export function middleware(req: NextRequest) {
  const root = process.env.ROOT_DOMAIN ?? "serveos.localhost";
  const host = req.headers.get("host") ?? root;
  const cls = classifyHost(host, root);

  const res = NextResponse.next();
  res.headers.set("x-surface", cls.surface);
  if (cls.surface === "storefront") {
    res.headers.set("x-tenant-slug", cls.slug);
  }
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|sw.js).*)"],
};
