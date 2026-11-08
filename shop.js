// Shop settings. These are public, safe to publish (no secrets ever go in this website).
//   paymentLink: the Stripe Payment Link for Smartway (https://buy.stripe.com/...). While empty, Buy opens an email.
//   worker:      the Cloudflare Worker that issues licence keys (https://smartway-shop.<you>.workers.dev).
//   demo:        the free one-road demo download (the Demo button on the home page).
// The full game has no public link: each buyer gets their own private download link (worker + /download?key=THEIR-KEY)
// on the thank-you page and in their key email. The zips live on a private GitHub release that only the worker can open.
var SHOP = {
  paymentLink: "https://buy.stripe.com/7sY14ng8V3OV3em2s73sI00",
  worker: "https://smartway-shop.plaztikman.workers.dev",
  demo: "https://smartway-shop.plaztikman.workers.dev/demo"
};
