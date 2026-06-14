import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";
import { listBanners } from "@/server/banners/service";
import { createBannerAction, toggleBannerAction, deleteBannerAction } from "./actions";

export default async function BannersPage() {
  const ctx = await requireDashboardUser();
  authorize(ctx.roleKeys, "menu:manage");
  const banners = await listBanners(ctx.tenantId);

  return (
    <main style={{ padding: 32, fontFamily: "system-ui" }}>
      <h1>Banners</h1>
      <ul>
        {banners.map((b) => {
          const toggle = toggleBannerAction.bind(null, b.id, !b.isActive);
          const del = deleteBannerAction.bind(null, b.id);
          return (
            <li key={b.id} style={{ marginBottom: 8 }}>
              <img src={b.imageUrl} alt={b.titleEn ?? ""} style={{ width: 120, height: 60, objectFit: "cover" }} />
              {" "}{b.titleEn ?? "(no title)"} — {b.isActive ? "active" : "inactive"}
              <form action={toggle} style={{ display: "inline" }}>
                <button type="submit" style={{ marginLeft: 8 }}>{b.isActive ? "Deactivate" : "Activate"}</button>
              </form>
              <form action={del} style={{ display: "inline" }}>
                <button type="submit" style={{ color: "red", marginLeft: 4 }}>Delete</button>
              </form>
            </li>
          );
        })}
      </ul>

      <h2>Add Banner</h2>
      <form action={createBannerAction}>
        <div><label>Image URL: <input name="imageUrl" required /></label></div>
        <div><label>Title (EN): <input name="titleEn" /></label></div>
        <div><label>Title (AR): <input name="titleAr" dir="rtl" /></label></div>
        <div><label>Link URL: <input name="linkUrl" /></label></div>
        <button type="submit">Create</button>
      </form>
    </main>
  );
}
