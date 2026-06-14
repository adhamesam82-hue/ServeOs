import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";
import { listCategories } from "@/server/catalog/service";
import { updateCategoryAction } from "../actions";

export default async function EditCategoryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireDashboardUser();
  authorize(ctx.roleKeys, "menu:manage");
  const cats = await listCategories(ctx.tenantId);
  const cat = cats.find((c) => c.id === id);
  if (!cat) return <main style={{ padding: 32 }}><p>Category not found.</p></main>;

  const updateAction = updateCategoryAction.bind(null, id);

  return (
    <main style={{ padding: 32, fontFamily: "system-ui" }}>
      <h1>Edit Category</h1>
      <form action={updateAction}>
        <div><label>Name (EN): <input name="nameEn" defaultValue={cat.nameEn} required /></label></div>
        <div><label>Name (AR): <input name="nameAr" defaultValue={cat.nameAr} required dir="rtl" /></label></div>
        <button type="submit">Save</button>
      </form>
      <p><a href="/dashboard/menu">← Back</a></p>
    </main>
  );
}
