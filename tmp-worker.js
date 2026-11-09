// Smartway shop: takes payment through PayPal and issues a licence key automatically.
//
// Works with PayPal (buttons on the page) or Stripe (a Stripe Payment Link). Use whichever you set up.
//
// Runs as a free Cloudflare Worker (100,000 requests a day, no card needed). The website's PayPal button calls it:
//   POST /order     creates a PayPal order for the fixed price (the price lives here, so the page can't change it)
//   POST /capture   takes the money, then makes a key in Firestore, emails it to the buyer and returns it to the page
//   POST /webhook   PayPal's own notifications: issues a key for a payment that cleared late, disables the key
//                   when a payment is refunded or charged back
//
// Keys are written straight to Firestore with a Google service account (the same kind of file KeyGen uses), so the
// Firebase project stays on the free Spark plan. Every order gets one key only: orders/{paypal order id} remembers it.
//
// Settings (Cloudflare dashboard > the worker > Settings > Variables and Secrets). Secrets marked *.
//   PAYPAL_ENV          "sandbox" while testing, "live" for real money
//   PAYPAL_CLIENT_ID    from developer.paypal.com > Apps & Credentials
//   PAYPAL_SECRET *     same place
//   PAYPAL_WEBHOOK_ID   the id PayPal shows after you add the webhook
//   PRICE               "12.99"
//   CURRENCY            "GBP"
//   ALLOWED_ORIGIN      "https://plaztikman.github.io"
//   FIREBASE_PROJECT    "smartway-5fadb"
//   GCP_SA_EMAIL        client_email from the service account file
//   GCP_SA_KEY *        private_key from the service account file (the whole -----BEGIN PRIVATE KEY----- block)
//   BREVO_API_KEY *     from brevo.com > SMTP & API > API keys
//   FROM_EMAIL          the sender address you verified in Brevo
//   FROM_NAME           "MVALIX Interactive"
//   NOTIFY_EMAIL        where to send a copy of every sale (your own inbox)
//   Downloads (the full game is NOT public; each buyer gets their own link, worker address + /download?key=THEIR-KEY):
//   GITHUB_REPO         the PRIVATE repo whose releases hold Smartway.zip and SmartwayDemo.zip, e.g. "Plaztikman/smartway-releases"
//   GITHUB_TOKEN *      fine-grained token, that one repo only, "Contents: Read-only"
//   DOWNLOAD_LIMIT      downloads allowed per key (default 20), so a shared link soon stops working
//   Stripe instead of (or as well as) PayPal:
//   STRIPE_SECRET_KEY *       a restricted key (rk_...) with only "Checkout Sessions: Read" (Developers > API keys)
//   STRIPE_WEBHOOK_SECRET *   whsec_... shown after adding the webhook endpoint
//   STRIPE_PAYMENT_LINK       the Payment Link's id (plink_...), so only Smartway checkouts get keys

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // same as LicenceClient.NewKey: no 0/O or 1/I

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    env = { ...env, WORKER_URL: env.WORKER_URL || url.origin }; // buyers' download links point back at this worker
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    try {
      if (request.method === "POST" && url.pathname === "/order") return json(await createOrder(env), 200, cors);
      if (request.method === "POST" && url.pathname === "/capture") {
        const { orderID } = await request.json();
        if (typeof orderID !== "string" || !/^[A-Z0-9]{5,40}$/.test(orderID)) return json({ error: "Bad order id." }, 400, cors);
        return json(await captureAndIssue(env, orderID), 200, cors);
      }
      if (request.method === "POST" && url.pathname === "/webhook") return await webhook(request, env);
      if (request.method === "GET" && url.pathname === "/stripe/key") {
        const id = url.searchParams.get("session") || "";
        if (!/^cs_(test|live)_[A-Za-z0-9]{10,200}$/.test(id)) return json({ error: "Bad checkout id." }, 400, cors);
        return json(await stripeIssueForSession(env, id), 200, cors);
      }
      if (request.method === "POST" && url.pathname === "/stripe/webhook") return await stripeWebhook(request, env);
      if (request.method === "GET" && url.pathname === "/download") return await download(env, url.searchParams.get("key"));
      if (request.method === "GET" && url.pathname === "/demo") return await demoDownload(env);
      if (request.method === "GET" && url.pathname === "/latest") return json(await latestInfo(env), 200, { ...cors, "Cache-Control": "public, max-age=300" });
      if (url.pathname === "/") return new Response("Smartway shop is running.", { headers: cors });
      return json({ error: "Not found." }, 404, cors);
    } catch (e) {
      console.log("error", e && e.stack || e);
      return json({ error: "Something went wrong on our side. If you were charged, your key will still be emailed to you." }, 500, cors);
    }
  },
};

// ---------- PayPal ----------

function paypalBase(env) {
  return env.PAYPAL_ENV === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
}

async function paypalToken(env) {
  const res = await fetch(paypalBase(env) + "/v1/oauth2/token", {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(env.PAYPAL_CLIENT_ID + ":" + env.PAYPAL_SECRET), "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error("PayPal sign-in failed " + res.status + " " + await res.text());
  return (await res.json()).access_token;
}

async function paypal(env, method, path, body) {
  const res = await fetch(paypalBase(env) + path, {
    method,
    headers: { Authorization: "Bearer " + await paypalToken(env), "Content-Type": "application/json", Prefer: "return=representation" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { ok: res.ok, status: res.status, data };
}

async function createOrder(env) {
  const r = await paypal(env, "POST", "/v2/checkout/orders", {
    intent: "CAPTURE",
    purchase_units: [{
      description: "Smartway: UK Motorway Traffic Controller (PC licence)",
      amount: { currency_code: env.CURRENCY || "GBP", value: env.PRICE || "12.99" },
    }],
    payment_source: { paypal: { experience_context: { brand_name: "Smartway", shipping_preference: "NO_SHIPPING", user_action: "PAY_NOW" } } },
  });
  if (!r.ok) throw new Error("create order failed " + r.status + " " + JSON.stringify(r.data));
  return { id: r.data.id };
}

async function captureAndIssue(env, orderID) {
  const c = await paypal(env, "POST", `/v2/checkout/orders/${orderID}/capture`, {});
  if (!c.ok) {
    const issue = c.data && c.data.details && c.data.details[0] && c.data.details[0].issue;
    if (issue === "INSTRUMENT_DECLINED") return { retry: true, error: "PayPal declined that payment method. Please pick another one." };
    if (issue !== "ORDER_ALREADY_CAPTURED") return { error: "PayPal couldn't take the payment, so you haven't been charged. Please try again." };
  }
  return await issueForOrder(env, orderID);
}

// Checks the order really was paid in full, then makes (or looks up) its key.
async function issueForOrder(env, orderID) {
  const o = await paypal(env, "GET", `/v2/checkout/orders/${orderID}`);
  if (!o.ok) throw new Error("get order failed " + o.status);
  const order = o.data;
  const unit = order.purchase_units && order.purchase_units[0];
  const capture = unit && unit.payments && unit.payments.captures && unit.payments.captures[0];
  const email = order.payer && order.payer.email_address;
  if (!capture || !email) return { error: "We couldn't find a payment for this order." };
  if (capture.amount.currency_code !== (env.CURRENCY || "GBP") || capture.amount.value !== (env.PRICE || "12.99"))
    return { error: "That payment wasn't the right amount. Please contact us." };
  if (capture.status === "PENDING")
    return { pending: true, email, message: "PayPal is still clearing your payment. Your key will be emailed to " + email + " as soon as it does." };
  if (capture.status !== "COMPLETED") return { error: "That payment didn't go through." };

  const name = order.payer.name ? [order.payer.name.given_name, order.payer.name.surname].filter(Boolean).join(" ") : "";
  return await issueAndEmail(env, "paypal", orderID, capture.id, email, name);
}

// Makes the order's key (once), emails it to the buyer and a copy of the sale to you.
async function issueAndEmail(env, source, orderID, paymentRef, email, name) {
  const { key, isNew } = await issueKey(env, orderID, paymentRef, email, source);
  if (isNew) {
    await sendKeyEmail(env, email, name, key).catch(e => console.log("email failed", e && e.message));
    if (env.NOTIFY_EMAIL)
      await sendEmail(env, env.NOTIFY_EMAIL, "Smartway sale: " + email, `<p>New sale (${source}).</p><p>Buyer: ${esc(name)} &lt;${esc(email)}&gt;<br>Key: <b>${key}</b><br>Order: ${esc(orderID)}</p>`)
        .catch(e => console.log("notify failed", e && e.message));
  }
  return { key, email: normaliseEmail(email), download: downloadLink(env, key) };
}

// Verifies a webhook really came from PayPal, then acts on it.
async function webhook(request, env) {
  const raw = await request.text();
  const h = request.headers;
  const v = await paypal(env, "POST", "/v1/notifications/verify-webhook-signature", {
    auth_algo: h.get("paypal-auth-algo"), cert_url: h.get("paypal-cert-url"), transmission_id: h.get("paypal-transmission-id"),
    transmission_sig: h.get("paypal-transmission-sig"), transmission_time: h.get("paypal-transmission-time"),
    webhook_id: env.PAYPAL_WEBHOOK_ID, webhook_event: JSON.parse(raw),
  });
  if (!v.ok || v.data.verification_status !== "SUCCESS") return new Response("bad signature", { status: 400 });

  const event = JSON.parse(raw);
  const res = event.resource || {};
  if (event.event_type === "PAYMENT.CAPTURE.COMPLETED") {
    const orderID = res.supplementary_data && res.supplementary_data.related_ids && res.supplementary_data.related_ids.order_id;
    if (orderID) await issueForOrder(env, orderID);
  } else if (event.event_type === "PAYMENT.CAPTURE.REFUNDED" || event.event_type === "PAYMENT.CAPTURE.REVERSED") {
    // refund resource links "up" to the capture; a reversal's resource is the capture itself
    let captureId = event.event_type === "PAYMENT.CAPTURE.REVERSED" ? res.id : null;
    const up = (res.links || []).find(l => l.rel === "up");
    if (!captureId && up) captureId = up.href.split("/").pop();
    if (captureId) {
      const cap = await paypal(env, "GET", `/v2/payments/captures/${captureId}`);
      const orderID = cap.ok && cap.data.supplementary_data && cap.data.supplementary_data.related_ids && cap.data.supplementary_data.related_ids.order_id;
      // only a full refund takes the key away; a partial refund (a goodwill gesture) leaves it working
      const fully = event.event_type === "PAYMENT.CAPTURE.REVERSED" || (cap.ok && cap.data.status === "REFUNDED");
      if (orderID && fully) await disableOrderKey(env, orderID, event.event_type === "PAYMENT.CAPTURE.REVERSED" ? "chargeback" : "refunded");
    }
  }
  return new Response("ok");
}

// ---------- Stripe ----------
// Uses a Stripe Payment Link made in the Stripe dashboard (no code there). After paying, Stripe sends the buyer to
//   https://plaztikman.github.io/smartway-site/thanks.html?session={CHECKOUT_SESSION_ID}
// which asks GET /stripe/key for the key. Stripe's webhook (checkout.session.completed) also issues it, so the buyer
// still gets the email if they close the tab. Refunds and disputes disable the key.

async function stripe(env, method, path, form) {
  const res = await fetch("https://api.stripe.com/v1/" + path, {
    method, headers: { Authorization: "Bearer " + env.STRIPE_SECRET_KEY, "Content-Type": "application/x-www-form-urlencoded" },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  return { ok: res.ok, status: res.status, data: await res.json() };
}

async function stripeIssueForSession(env, sessionId) {
  const r = await stripe(env, "GET", "checkout/sessions/" + sessionId);
  if (!r.ok) return { error: "We couldn't find that checkout." };
  const s = r.data;
  if (s.status !== "complete") return { error: "That checkout wasn't finished, so you haven't been charged." };
  const email = (s.customer_details && s.customer_details.email) || s.customer_email;
  if (!email) return { error: "We couldn't find the email for this order. Please contact us." };
  if (env.STRIPE_PAYMENT_LINK && s.payment_link !== env.STRIPE_PAYMENT_LINK) return { error: "That checkout isn't for Smartway." };
  if (s.payment_status !== "paid")
    return { pending: true, email, message: "Your payment is still clearing. Your key will be emailed to " + email + " as soon as it does." };
  const name = (s.customer_details && s.customer_details.name) || "";
  return await issueAndEmail(env, "stripe", sessionId, s.payment_intent || "", email, name);
}

async function stripeWebhook(request, env) {
  const raw = await request.text();
  if (!await stripeSignatureOk(raw, request.headers.get("Stripe-Signature") || "", env.STRIPE_WEBHOOK_SECRET))
    return new Response("bad signature", { status: 400 });
  const event = JSON.parse(raw);
  const obj = event.data && event.data.object || {};
  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    await stripeIssueForSession(env, obj.id);
  } else if (event.type === "charge.refunded" || event.type === "charge.dispute.created") {
    const pi = obj.payment_intent;
    const fully = event.type === "charge.dispute.created" || obj.refunded === true; // partial refunds keep the key
    if (pi && fully) {
      const l = await stripe(env, "GET", "checkout/sessions?limit=1&payment_intent=" + encodeURIComponent(pi));
      const session = l.ok && l.data.data && l.data.data[0];
      if (session) await disableOrderKey(env, session.id, event.type === "charge.dispute.created" ? "chargeback" : "refunded");
    }
  }
  return new Response("ok");
}

// Stripe-Signature: t=timestamp,v1=hex hmac-sha256 of "t.body" with the webhook secret. Rejects anything over 5 minutes old.
async function stripeSignatureOk(raw, header, secret) {
  if (!secret) return false;
  const parts = Object.fromEntries(header.split(",").map(p => p.split("=")).filter(p => p.length === 2).map(([k, v]) => [k, v]));
  const sigs = header.split(",").filter(p => p.startsWith("v1=")).map(p => p.slice(3));
  const t = parseInt(parts.t, 10);
  if (!t || !sigs.length || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(t + "." + raw)));
  const hex = [...mac].map(b => b.toString(16).padStart(2, "0")).join("");
  return sigs.some(s => s.length === hex.length && [...s].reduce((d, c, i) => d | (c.charCodeAt(0) ^ hex.charCodeAt(i)), 0) === 0);
}

// ---------- Firestore (REST, signed in as the service account) ----------

let cachedGoogle = null;
async function googleToken(env) {
  if (cachedGoogle && cachedGoogle.exp > Date.now() / 1000 + 60) return cachedGoogle.token;
  const now = Math.floor(Date.now() / 1000);
  const enc = o => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = enc({ alg: "RS256", typ: "JWT" }) + "." + enc({
    iss: env.GCP_SA_EMAIL, scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  });
  const pem = env.GCP_SA_KEY.replace(/\\n/g, "\n").replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), ch => ch.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=" + unsigned + "." + b64url(new Uint8Array(sig)),
  });
  if (!res.ok) throw new Error("Google sign-in failed " + res.status + " " + await res.text());
  const t = await res.json();
  cachedGoogle = { token: t.access_token, exp: now + (t.expires_in || 3600) };
  return cachedGoogle.token;
}

function docsBase(env) { return `projects/${env.FIREBASE_PROJECT}/databases/(default)/documents`; }

async function firestore(env, method, path, body) {
  const res = await fetch("https://firestore.googleapis.com/v1/" + path, {
    method, headers: { Authorization: "Bearer " + await googleToken(env), "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, data: text ? JSON.parse(text) : {} };
}

async function getOrderDoc(env, orderID) {
  const r = await firestore(env, "GET", `${docsBase(env)}/orders/${orderID}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("read order failed " + r.status);
  return r.data.fields;
}

// One key per order, written together with orders/{id} in a single commit that fails if the order already has one,
// so two calls at once (the page and the webhook) can never make two keys.
async function issueKey(env, orderID, captureId, rawEmail, source) {
  const existing = await getOrderDoc(env, orderID);
  if (existing) return { key: existing.key.stringValue, isNew: false };
  const email = normaliseEmail(rawEmail);
  const emailHash = await sha256Hex(email);
  const now = new Date().toISOString();
  for (let attempt = 0; attempt < 5; attempt++) {
    const key = newKey();
    const r = await firestore(env, "POST", `${docsBase(env)}:commit`, {
      writes: [
        {
          update: { name: `${docsBase(env)}/licences/${key}`, fields: {
            emailHash: { stringValue: emailHash }, issuedTo: { stringValue: email }, status: { stringValue: "unused" },
            createdAt: { timestampValue: now }, source: { stringValue: source || "paypal" }, order: { stringValue: orderID },
          } },
          currentDocument: { exists: false },
        },
        {
          update: { name: `${docsBase(env)}/orders/${orderID}`, fields: {
            key: { stringValue: key }, email: { stringValue: email }, capture: { stringValue: captureId || "" },
            status: { stringValue: "paid" }, createdAt: { timestampValue: now },
          } },
          currentDocument: { exists: false },
        },
      ],
    });
    if (r.ok) return { key, isNew: true };
    // failed precondition: either the key already exists (try another) or the order got its key a moment ago
    const again = await getOrderDoc(env, orderID);
    if (again) return { key: again.key.stringValue, isNew: false };
    if (r.status !== 409 && r.status !== 400) throw new Error("write key failed " + r.status + " " + JSON.stringify(r.data));
  }
  throw new Error("couldn't make a unique key");
}

async function disableOrderKey(env, orderID, why) {
  const o = await getOrderDoc(env, orderID);
  if (!o) return;
  const key = o.key.stringValue;
  const base = docsBase(env);
  const r = await firestore(env, "POST", `${base}:commit`, {
    writes: [
      { update: { name: `${base}/licences/${key}`, fields: { status: { stringValue: "disabled" }, disabledReason: { stringValue: why } } },
        updateMask: { fieldPaths: ["status", "disabledReason"] }, currentDocument: { exists: true } },
      { update: { name: `${base}/orders/${orderID}`, fields: { status: { stringValue: why } } },
        updateMask: { fieldPaths: ["status"] }, currentDocument: { exists: true } },
    ],
  });
  if (!r.ok) throw new Error("disable failed " + r.status);
  if (env.NOTIFY_EMAIL)
    await sendEmail(env, env.NOTIFY_EMAIL, "Smartway " + why + ": key disabled", `<p>PayPal order ${esc(orderID)} was ${why}. Key <b>${key}</b> (${esc(o.email.stringValue)}) is now disabled.</p>`).catch(() => {});
}

// ---------- Email (Brevo free plan: 300 a day) ----------

async function sendEmail(env, to, subject, html) {
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": env.BREVO_API_KEY, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ sender: { email: env.FROM_EMAIL, name: env.FROM_NAME || "Smartway" }, to: [{ email: to }], subject, htmlContent: html }),
  });
  if (!res.ok) throw new Error("Brevo " + res.status + " " + await res.text());
}

function sendKeyEmail(env, email, name, key) {
  const hi = name ? "Hi " + esc(name.split(" ")[0]) + "," : "Hi,";
  const link = downloadLink(env, key);
  const dl = link ? `<p><a href="${esc(link)}" style="display:inline-block;background:#f5a623;color:#111;font-weight:bold;padding:10px 18px;border-radius:6px;text-decoration:none">Download Smartway</a></p>
<p style="color:#555;font-size:14px">This download link is yours alone (it works with your key), so please don&#39;t share it.</p>
<p style="color:#555;font-size:14px">Right-click the zip and choose <b>Extract All</b> before playing (it won&#39;t work from inside the zip), then open Smartway.exe. If Windows says &quot;Windows protected your PC&quot;, click <b>More info</b>, then <b>Run anyway</b>. That appears because we&#39;re a new indie studio, not because anything is wrong.</p>` : "";
  return sendEmail(env, email, "Your Smartway licence key", `
<div style="font-family:Segoe UI,Arial,sans-serif;font-size:15px;line-height:1.5;color:#111">
<p>${hi}</p>
<p>Thanks for buying Smartway: UK Motorway Traffic Controller. Here's your licence key:</p>
<p style="font-family:Consolas,monospace;font-size:20px;font-weight:bold;letter-spacing:1px;background:#f3f3f3;padding:12px 16px;border-radius:6px;display:inline-block">${key}</p>
<p>When the game asks, type this email address and the key:<br><b>${esc(normaliseEmail(email))}</b></p>
${dl}
<p>One key activates the game on one PC. If you change PC, just reply to this email and we'll move it for you.</p>
<p>Enjoy the shift,<br>Matt, MVALIX Interactive</p>
</div>`);
}

// ---------- Downloads (private GitHub release) ----------
// Smartway.zip and SmartwayDemo.zip sit on the newest release of a PRIVATE GitHub repo, so nobody can download them
// from GitHub directly. /download?key=KEY checks the key in Firestore (exists, not disabled after a refund, under the
// download limit), counts the download, then sends the browser to a GitHub link that only works for a few minutes.
// /demo does the same for the demo with no key. /latest tells the game's update notice the newest version.

let cachedRelease = null;
async function latestRelease(env) {
  if (cachedRelease && cachedRelease.at > Date.now() - 5 * 60 * 1000) return cachedRelease.data;
  if (!env.GITHUB_REPO || !env.GITHUB_TOKEN) throw new Error("GITHUB_REPO / GITHUB_TOKEN not set");
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/releases/latest`, { headers: githubHeaders(env, "application/vnd.github+json") });
  if (res.status === 404) return null; // no release published yet
  if (!res.ok) throw new Error("GitHub releases " + res.status + " " + await res.text());
  const data = await res.json();
  cachedRelease = { at: Date.now(), data };
  return data;
}

function githubHeaders(env, accept) {
  return { Authorization: "Bearer " + env.GITHUB_TOKEN, Accept: accept, "User-Agent": "smartway-shop", "X-GitHub-Api-Version": "2022-11-28" };
}

// Asks GitHub for a short-lived link to one file of the newest release (null if there's no such file yet).
async function assetLink(env, name) {
  const rel = await latestRelease(env);
  const asset = rel && (rel.assets || []).find(a => a.name.toLowerCase() === name.toLowerCase());
  if (!asset) return null;
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/releases/assets/${asset.id}`, { headers: githubHeaders(env, "application/octet-stream"), redirect: "manual" });
  const to = res.headers.get("Location");
  if (res.status < 300 || res.status >= 400 || !to) throw new Error("GitHub asset " + res.status);
  return to;
}

function notReady() { return page(503, "Download not ready", "The download isn't up yet. Please try again a little later, or reply to your purchase email."); }
function redirect(to) { return new Response(null, { status: 302, headers: { Location: to, "Cache-Control": "no-store" } }); }

async function download(env, rawKey) {
  const key = String(rawKey || "").trim().toUpperCase().replace(/\s+/g, "");
  if (!/^SMWY(-[A-Z0-9]{4}){4}$/.test(key)) return page(400, "Link not valid", "This download link isn't complete. Use the Download button in your purchase email.");
  const base = docsBase(env);
  const r = await firestore(env, "GET", `${base}/licences/${key}`);
  if (r.status === 404) return page(404, "Link not valid", "We couldn't find that licence key. Use the Download button in your purchase email.");
  if (!r.ok) throw new Error("read licence failed " + r.status);
  const f = r.data.fields || {};
  if (f.status && f.status.stringValue === "disabled") return page(403, "Licence disabled", "This licence has been disabled, so the download isn't available. If you think that's a mistake, reply to your purchase email.");
  const count = parseInt(f.downloads && f.downloads.integerValue || "0", 10);
  const limit = parseInt(env.DOWNLOAD_LIMIT || "20", 10);
  if (count >= limit) return page(429, "Download limit reached", "This link has been used a lot of times, so it's been paused. Reply to your purchase email and we'll sort you out.");
  const to = await assetLink(env, "Smartway.zip");
  if (!to) return notReady();
  await firestore(env, "POST", `${base}:commit`, { writes: [{
    transform: { document: `${base}/licences/${key}`, fieldTransforms: [
      { fieldPath: "downloads", increment: { integerValue: "1" } },
      { fieldPath: "lastDownloadAt", setToServerValue: "REQUEST_TIME" },
    ] },
    currentDocument: { exists: true },
  }] }).catch(e => console.log("count failed", e && e.message));
  return redirect(to);
}

async function demoDownload(env) {
  const to = await assetLink(env, "SmartwayDemo.zip");
  return to ? redirect(to) : notReady();
}

// What the game's update notice needs: the newest version and its notes (no links, those come from /download and /demo).
async function latestInfo(env) {
  const rel = await latestRelease(env);
  if (!rel) return { tag_name: "" };
  return { tag_name: rel.tag_name, name: rel.name || "", body: rel.body || "", draft: !!rel.draft, prerelease: !!rel.prerelease,
    assets: (rel.assets || []).map(a => ({ name: a.name })) };
}

function downloadLink(env, key) {
  return env.WORKER_URL ? env.WORKER_URL.replace(/\/+$/, "") + "/download?key=" + encodeURIComponent(key) : (env.DOWNLOAD_URL || "");
}

function page(status, title, text) {
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<body style="font-family:Segoe UI,Arial,sans-serif;background:#0b0f14;color:#e8e8e8;display:grid;place-items:center;min-height:90vh;margin:0;padding:16px">
<div style="max-width:460px;border-left:6px solid #f5a623;background:#121820;padding:20px 24px"><h1 style="font-size:20px;margin:0 0 8px">${esc(title)}</h1><p style="margin:0;line-height:1.5">${esc(text)}</p>
<p style="margin:14px 0 0"><a style="color:#f5a623" href="https://smartway.mvalix.com/">smartway.mvalix.com</a></p></div></body>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

// ---------- helpers ----------

function newKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let s = "SMWY";
  for (let g = 0; g < 4; g++) { s += "-"; for (let i = 0; i < 4; i++) s += ALPHABET[bytes[g * 4 + i] & 31]; }
  return s;
}
function normaliseEmail(e) { return String(e || "").trim().toLowerCase(); }
async function sha256Hex(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
}
function b64url(bytes) {
  let bin = ""; for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean);
  return {
    "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : (allowed[0] || "*"),
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", Vary: "Origin",
  };
}
function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { ...headers, "Content-Type": "application/json" } });
}

export const _test = { newKey, sha256Hex, normaliseEmail, stripeSignatureOk, resetReleaseCache: () => { cachedRelease = null; } };
