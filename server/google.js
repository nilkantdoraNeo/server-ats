// google.js — FINAL SIMPLE VERSION (always returns one meet link)

function createGoogleMeetEvent() {
  return process.env.GLOBAL_MEET_LINK;
}

module.exports = { createGoogleMeetEvent };
