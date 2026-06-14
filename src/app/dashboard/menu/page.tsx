import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";
import { listCategories, listProducts } from "@/server/catalog/service";
import { deleteCategoryAction } from "./categories/actions";

export default async function MenuPage() {
  const ctx = await requireDashboardUser();
  authorize(ctx.roleKeys, "menu:manage");
  const cats = await listCategories(ctx.tenantId);
  const prods = await listProducts(ctx.tenantId);

  return (
    <main style={{ padding: 32, fontFamily: "system-ui" }}>
      <h1>Menu</h1>
      <p><a href="/dashboard/menu/categories/new">+ New Category</a></p>
      {cats.map((cat) => {
        const catProds = prods.filter((p) => p.categoryId === cat.id);
        const delCat = deleteCategoryAction.bind(null, cat.id);
        return (
          <section key={cat.id} style={{ marginBottom: 24 }}>
            <h2>
              {cat.nameEn} / {cat.nameAr}
              {" "}<a href={`/dashboard/menu/categories/${cat.id}`}>[edit]</a>
              {catProds.length === 0 && (
                <form action={delCat} style={{ display: "inline" }}>
                  <button type="submit" style={{ color: "red", marginLeft: 8 }}>[delete]</button>
                </form>
              )}
            </h2>
            <ul>
              {catProds.map((p) => (
                <li key={p.id}>
                  <a href={`/dashboard/menu/products/${p.id}`}>{p.nameEn}</a>
                  {" "}{p.isPublished ? "✓" : "(draft)"}
                  {" "}${p.basePrice}
                </li>
              ))}
            </ul>
            <a href={`/dashboard/menu/products/new?categoryId=${cat.id}`}>+ Add Product</a>
          </section>
        );
      })}
    </main>
  );
}
