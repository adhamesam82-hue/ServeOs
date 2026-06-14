import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";
import { createCategoryAction } from "../actions";

export default async function NewCategoryPage() {
  const ctx = await requireDashboardUser();
  authorize(ctx.roleKeys, "menu:manage");

  return (
    <main style={{ padding: 32, fontFamily: "system-ui" }}>
      <h1>New Category</h1>
      <form action={createCategoryAction}>
        <div><label>Name (EN): <input name="nameEn" required /></label></div>
        <div><label>Name (AR): <input name="nameAr" required dir="rtl" /></label></div>
        <div><label>Description (EN): <input name="descriptionEn" /></label></div>
        <div><label>Description (AR): <input name="descriptionAr" dir="rtl" /></label></div>
        <button type="submit">Create</button>
      </form>
      <p><a href="/dashboard/menu">← Back</a></p>
    </main>
  );
}
