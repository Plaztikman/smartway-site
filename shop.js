// Shop settings. These are public, safe to publish (no secrets ever go in this website).
//   paymentLink: the Stripe Payment Link for Smartway (https://buy.stripe.com/...). While empty, Buy opens an email.
//   worker:      the Cloudflare Worker that issues licence keys (https://smartway-shop.<you>.workers.dev).
//   download:    where buyers download the game.
var SHOP = {
  paymentLink: "https://buy.stripe.com/7sY14ng8V3OV3em2s73sI00",
  worker: "https://smartway-shop.plaztikman.workers.dev",
  download: "https://github.com/Plaztikman/smartway-site/releases/latest/download/Smartway.zip"   // link to the game download, shown on the thank-you page
};
