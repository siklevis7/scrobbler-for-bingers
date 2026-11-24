// Experimental: Apple TV+, Hulu, Paramount+, Peacock. No site-specific reader yet; relies on
// what the page reports to the browser's media controls (the Media Session API).
BingersScrobbler.start({
  service: "generic",
  getMedia() {
    return BSParse.fromMediaSession();
  },
});
