#!/usr/bin/env node
/**
 * E2E POS por API — plano-pos-br.md §5.4 + critérios §6.6.
 *
 * Node puro com fetch, sem dependências. Replica o contrato exato do app de
 * caixa (medusa-pos): login → /pos/health → produtos brl → região Brasil
 * primeira → draft order → convert-to-order → payment collection → session →
 * markAsPaid → captured → refund. Nos critérios de Fase 1, afirma também que
 * payments[0].provider_id === pp_pos-terminal_card (sem queda para
 * pp_system_default) e que /store/payment-providers lista os 5 (a rota admin
 * não existe no Medusa 2.19).
 *
 * Uso:
 *   BACKEND_URL=http://100.109.66.40:9000 \
 *   ADMIN_EMAIL=admin@voolulabs.com ADMIN_PASSWORD=... node scripts/e2e-pos.mjs
 */
const BASE = process.env.BACKEND_URL ?? "http://localhost:9000"
const EMAIL = process.env.ADMIN_EMAIL
const PASSWORD = process.env.ADMIN_PASSWORD

if (!EMAIL || !PASSWORD) {
  console.error("ADMIN_EMAIL e ADMIN_PASSWORD são obrigatórios no ambiente")
  process.exit(1)
}

let failed = false
function step(name, ok, detail = "") {
  const mark = ok ? "PASS" : "FAIL"
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failed = true
}

async function req(method, path, body, token, extraHeaders = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json = {}
  try {
    json = JSON.parse(text)
  } catch {
    json = { raw: text.slice(0, 200) }
  }
  return { status: res.status, json }
}

const main = async () => {
  // 1. login
  const login = await req("POST", "/auth/user/emailpass", { email: EMAIL, password: PASSWORD })
  const token = login.json.token
  step("login admin", login.status === 200 && !!token)
  if (!token) process.exit(1)

  // 2. health do plugin de catálogo
  const health = await req("GET", "/pos/health", undefined, token)
  step("GET /pos/health", health.status === 200 && health.json.status === "ok")

  // 3. health do plugin de pagamentos (Fase 1, §6.3)
  const payHealth = await req("GET", "/admin/pos-payments/health", undefined, token)
  step(
    "GET /admin/pos-payments/health",
    payHealth.status === 200 && payHealth.json.status === "ok"
  )

  // 4. regiões — Brasil (brl) precisa ser a primeira (o app usa a primeira)
  const regions = await req("GET", "/admin/regions?limit=10", undefined, token)
  const list = regions.json.regions ?? []
  const brasil = list.find((r) => r.currency_code === "brl")
  step(
    "região Brasil é a primeira",
    list[0]?.currency_code === "brl",
    list.map((r) => r.name).join(", ")
  )

  // 5. providers registrados (§6.6: pp_system_default + 4 pp_pos-terminal_*)
  // No Medusa 2.19 a listagem vive no store (admin não expõe a rota); a checagem
  // usa a publishable key + region_id — o mesmo caminho do app de caixa.
  const keys = await req("GET", "/admin/api-keys?limit=10", undefined, token)
  const pubKey = (keys.json.api_keys ?? []).find((k) => k.type === "publishable")?.token
  const regionId = (regions.json.regions ?? [])[0]?.id
  const providers = await req(
    "GET",
    `/store/payment-providers?region_id=${regionId}`,
    undefined,
    undefined,
    { "x-publishable-api-key": pubKey ?? "" }
  )
  const ids = (providers.json.payment_providers ?? []).map((p) => p.id)
  const expected = [
    "pp_system_default",
    "pp_pos-terminal_card",
    "pp_pos-terminal_pix",
    "pp_pos-terminal_cash",
    "pp_pos-terminal_transfer",
  ]
  const missing = expected.filter((id) => !ids.includes(id))
  step("providers registrados", missing.length === 0, missing.length ? `faltam: ${missing}` : ids.join(","))

  // 6. canal + produtos brl
  const channels = await req("GET", "/admin/sales-channels?limit=5", undefined, token)
  const channel = (channels.json.sales_channels ?? [])[0]
  const products = await req(
    "GET",
    `/pos/products/${channel.id}?currency_code=brl&limit=10`,
    undefined,
    token
  )
  const prods = Array.isArray(products.json) ? products.json : products.json.products ?? []
  const variants = prods.flatMap((p) => p.variants ?? []).filter((v) => v.calculated_price)
  step("produtos brl com calculated_price", variants.length > 0, `${prods.length} produtos`)

  // 7. draft order + convert
  const draft = await req(
    "POST",
    "/admin/draft-orders",
    {
      email: "cliente@teste.local",
      region_id: brasil.id,
      sales_channel_id: channel.id,
      items: [{ variant_id: variants[0].id, quantity: 1 }],
      shipping_address: {
        first_name: "Teste",
        last_name: "E2E",
        address_1: "Rua Um",
        city: "São Paulo",
        country_code: "br",
        postal_code: "01310100",
      },
    },
    token
  )
  const draftOrder = draft.json.draft_order ?? {}
  const draftId = draftOrder.id
  step("draft order criado", draft.status === 200 && !!draftId)

  const converted = await req("POST", `/admin/draft-orders/${draftId}/convert-to-order`, {}, token)
  const order = converted.json.order ?? { id: draftId, total: draftOrder.total }
  const orderId = order.id ?? draftId
  step("convert-to-order", converted.status === 200, `order ${orderId}`)

  // 8. ordem completa (total + status)
  const fetched = await req("GET", `/admin/orders/${orderId}`, undefined, token)
  const full = fetched.json.order ?? {}
  const amount = full.summary?.accounting_total ?? full.total

  // 9. payment collection + session com provider verbatim (§2.2)
  const collection = await req(
    "POST",
    "/admin/payment-collections",
    { order_id: orderId, amount },
    token
  )
  const collectionId = collection.json.payment_collection?.id
  step("payment collection", collection.status === 200 && !!collectionId)

  const session = await req(
    "POST",
    `/admin/payment-collections/${collectionId}/payment-sessions?fields=*payment_sessions,*payments`,
    { provider_id: "pp_pos-terminal_card" },
    token
  )
  step("session pp_pos-terminal_card", session.status === 200)

  // 10. markAsPaid → captured (§6.2: authorize roda dentro do markAsPaid)
  const paid = await req(
    "POST",
    `/admin/payment-collections/${collectionId}/mark-as-paid`,
    { order_id: orderId, provider_id: "pp_pos-terminal_card" },
    token
  )
  step("markAsPaid", paid.status === 200)

  // 11. critério §6.6: payment_status captured E provider_id preservado.
  // Em v2 o payment não fica em order.payments — vive em
  // payment_collections[].payments[] (as rotas admin de collection nem
  // expõem GET no 2.19; o order é a fonte).
  const after = await req(
    "GET",
    `/admin/orders/${orderId}?fields=+payment_collections.payments.*`,
    undefined,
    token
  )
  const finalOrder = after.json.order ?? {}
  const payment = (finalOrder.payment_collections ?? [])
    .flatMap((c) => c.payments ?? [])[0]
  step(
    "payment_status = captured",
    finalOrder.payment_status === "captured",
    finalOrder.payment_status
  )
  step(
    "provider_id preservado (sem queda para pp_system_default)",
    payment?.provider_id === "pp_pos-terminal_card",
    payment?.provider_id
  )

  // 12. refund (§5.4)
  const refund = await req(
    "POST",
    `/admin/payments/${payment?.id}/refund`,
    { amount },
    token
  )
  step("refund", refund.status === 200)

  console.log(failed ? "\n== E2E FALHOU ==" : "\n== E2E OK ==")
  process.exit(failed ? 1 : 0)
}

main().catch((err) => {
  console.error("erro fatal:", err)
  process.exit(1)
})
