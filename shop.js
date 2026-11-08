// Shop settings. These are public, safe to publish (no secrets ever go in this website).
//   paymentLink: the Stripe Payment Link for Smartway (https://buy.stripe.com/...). While empty, Buy opens an email.
//   worker:      the Cloudflare Worker that issues licence keys (https://smartway-shop.<you>.workers.dev).
//   download:    where buyers download the game.
var SHOP = {
  paymentLink: "",
  worker: "https://smartway-shop.plaztikman.workers.dev",
  download: ""   // link to the game download, shown on the thank-you page
};
