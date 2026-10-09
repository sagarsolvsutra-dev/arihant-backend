// GSTIN business-detail lookup via gstinapi.in — the one piece of GST
// auto-fill that genuinely needs an external, paid API: a GSTIN's own digits
// only encode its state code and PAN (see lib/gst.ts on the frontend, which
// derives those two locally with no network call at all). Legal name, trade
// name, and the registered address only exist in the government's own GST
// database, which this endpoint is the single, server-side gateway to — the
// API key never reaches the browser.
const GSTINAPI_BASE_URL = "https://www.gstinapi.in/v1/gstin";

const GSTIN_SHAPE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/i;

exports.lookupGstin = async (req, res) => {
  try {
    const gstin = (req.params.gstin || "").trim().toUpperCase();
    if (!GSTIN_SHAPE.test(gstin)) {
      return res.status(400).json({ message: "Invalid GSTIN format" });
    }

    const apiKey = process.env.GSTINAPI_KEY;
    if (!apiKey) {
      // Not a 500 — this is an expected, documented state (CLAUDE.md quirk
      // #58) until the user signs up and adds a key, not a bug.
      return res.status(503).json({ message: "GST lookup isn't configured yet — add GSTINAPI_KEY to the backend .env" });
    }

    let upstream;
    try {
      upstream = await fetch(`${GSTINAPI_BASE_URL}/${gstin}`, {
        headers: { "x-api-key": apiKey },
      });
    } catch (networkErr) {
      return res.status(502).json({ message: "Could not reach the GST verification service" });
    }

    const body = await upstream.json().catch(() => null);

    if (upstream.status === 401) {
      return res.status(502).json({ message: "GST lookup is misconfigured (invalid API key) — check GSTINAPI_KEY" });
    }
    if (upstream.status === 402) {
      return res.status(502).json({ message: "GST lookup is out of credits — top up the gstinapi.in account" });
    }
    if (upstream.status === 404) {
      return res.status(404).json({ message: "This GSTIN is not registered" });
    }
    if (upstream.status === 429) {
      return res.status(429).json({ message: "Too many GST lookups right now — try again in a moment" });
    }
    if (!upstream.ok || !body || body.success === false) {
      return res.status(502).json({ message: (body && body.error) || "GST lookup failed" });
    }

    const d = body.data || {};
    // Normalized to this app's own Customer/Supplier field names, so the
    // frontend never has to know gstinapi.in's own field naming.
    res.status(200).json({
      legalName: d.legal_name || "",
      tradeName: d.trade_name || "",
      status: d.status || "",
      address: d.address || "",
      city: (d.address_details && d.address_details.locality) || d.city || "",
      pincode: d.pincode || "",
      stateCode: d.state_code || gstin.slice(0, 2),
    });
  } catch (error) {
    res.status(500).json({ message: error.message || "GST lookup failed" });
  }
};
