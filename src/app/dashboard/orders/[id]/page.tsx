import Link from "next/link";
import { requireOrdersPermission } from "../../orders-permission";
import { getOrder } from "@/server/ordering/service";
import { nextStatuses } from "@/server/ordering/state-machine";
import { transitionOrderAction, markPaidAction } from "./actions";

export default async function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { tenantId } = await requireOrdersPermission();
  const order = await getOrder(tenantId, id);
  const actions = nextStatuses(order.status, order.fulfillmentType);

  return (
    <main style={{ padding: 32, fontFamily: "system-ui", maxWidth: 560 }}>
      <Link href="/dashboard/orders">← Orders</Link>
      <h1>Order #{order.orderNumber} <span style={{ fontSize: 14, textTransform: "capitalize" }}>· {order.status.replace(/_/g, " ")}</span></h1>
      <p style={{ color: "#374151" }}>
        {order.customerName} · {order.customerPhone}<br />
        {order.fulfillmentType === "delivery" ? `🛵 Delivery → ${order.deliveryAreaNameSnapshot ?? ""}, ${order.deliveryAddressText ?? ""}` : "🥡 Pickup"}<br />
        💵 Cash · <span style={{ color: order.paymentStatus === "paid" ? "#15803d" : "#b91c1c" }}>{order.paymentStatus}</span>
        {order.notes && <><br />📝 {order.notes}</>}
      </p>

      <div style={{ border: "1px solid #eee", borderRadius: 6, padding: 10 }}>
        {order.items.map((it) => (
          <div key={it.id}>{it.quantity}× {it.nameEn}{it.selectedModifiers.length > 0 && <span style={{ color: "#6b7280" }}> ({it.selectedModifiers.map((m) => m.optionNameEn).join(", ")})</span>} … {Number(it.lineTotal).toFixed(2)}</div>
        ))}
        <div style={{ borderTop: "1px solid #eee", marginTop: 6, paddingTop: 6 }}>
          Subtotal {Number(order.subtotal).toFixed(2)} · VAT {Number(order.vatAmount).toFixed(2)} · Delivery {Number(order.deliveryFee).toFixed(2)}<br />
          <strong>Total {Number(order.total).toFixed(2)}</strong>
        </div>
      </div>

      <div style={{ marginTop: 16, display: "flex", gap: 8, flexWrap: "wrap" }}>
        {actions.map((to) => {
          const danger = to === "cancelled" || to === "rejected";
          const action = transitionOrderAction.bind(null, id, to, danger ? "Cancelled by staff" : undefined);
          return (
            <form key={to} action={action}>
              <button style={{ background: danger ? "#b91c1c" : "#0f172a", color: "#fff", border: 0, borderRadius: 6, padding: "8px 14px", textTransform: "capitalize" }}>{to.replace(/_/g, " ")}</button>
            </form>
          );
        })}
        {order.paymentStatus === "unpaid" && (
          <form action={markPaidAction.bind(null, id)}>
            <button style={{ background: "#374151", color: "#fff", border: 0, borderRadius: 6, padding: "8px 14px" }}>Mark paid</button>
          </form>
        )}
      </div>

      <h3 style={{ marginTop: 24 }}>History</h3>
      <ul style={{ fontSize: 13, color: "#6b7280" }}>
        {order.events.map((e) => <li key={e.id}>{e.fromStatus ? `${e.fromStatus} → ` : ""}{e.toStatus}{e.reason ? ` (${e.reason})` : ""} · {new Date(e.createdAt).toLocaleString()}</li>)}
      </ul>
    </main>
  );
}
