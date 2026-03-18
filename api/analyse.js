import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";

// ── PLAN LIMITS ───────────────────────────────────────────────────────
const PLAN_LIMITS = { free: 3, starter: 25, team: 999 };

// Character limits per plan (approx token cost control)
// free:    5,000 chars  ≈  ~200 lines RPG  ≈ ~$0.02 per analysis
// starter: 30,000 chars ≈ ~1,200 lines RPG  ≈ ~$0.10 per analysis
// team:    150,000 chars ≈ ~6,000 lines RPG  ≈ ~$0.50 per analysis
const CHAR_LIMITS = { free: 30000, starter: 100000, team: 300000 };

// Friendly names for error messages
const PLAN_NAMES = { free: "Free", starter: "Starter", team: "Team" };
const UPGRADE_HINTS = {
  free:    "Upgrade to Starter (₹1,999/mo) to analyse programs up to 100,000 characters.",
  starter: "Upgrade to Team (₹6,999/mo) to analyse programs up to 300,000 characters.",
  team:    "Contact support for enterprise limits above 150,000 characters."
};

export default async function handler(req, res) {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "https://rpglens.vercel.app");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    // ── 1. AUTHENTICATE USER ──────────────────────────────────────────
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Not authenticated. Please sign in." });
    }

    const token = authHeader.split(" ")[1];
    const sb = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    const { data: { user }, error: authError } = await sb.auth.getUser(token);
    if (authError || !user) {
      return res.status(401).json({ error: "Session expired. Please sign in again." });
    }

    // ── 2. CHECK PLAN & MONTHLY USAGE ────────────────────────────────
    const plan = user.user_metadata?.plan || "free";
    const monthlyLimit = PLAN_LIMITS[plan] || 3;
    const charLimit    = CHAR_LIMITS[plan]  || 30000;
    const monthKey     = `${new Date().getFullYear()}-${new Date().getMonth()}`;

    const { data: usage } = await sb
      .from("usage")
      .select("count")
      .eq("user_id", user.id)
      .eq("month_key", monthKey)
      .single();

    const currentCount = usage?.count || 0;

    if (currentCount >= monthlyLimit) {
      return res.status(429).json({
        error: `Monthly limit reached. You have used ${currentCount} of ${monthlyLimit} analyses this month. Your limit resets on the 1st of next month.`,
        upgrade: plan !== "team"
      });
    }

    // ── 3. VALIDATE REQUEST & ENFORCE CHARACTER LIMIT ─────────────────
    const { prompt, analysisType, codeLength } = req.body;

    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ error: "No code provided." });
    }

    // codeLength is sent separately by the client (length of just the code,
    // not the full prompt with instructions). Fall back to prompt.length.
    const programLength = codeLength || prompt.length;

    if (programLength > charLimit) {
      const kb = Math.round(programLength / 1000);
      const limitKb = Math.round(charLimit / 1000);
      return res.status(413).json({
        error: `Program too large for your ${PLAN_NAMES[plan]} plan. Your program is approximately ${kb}KB (${programLength.toLocaleString()} characters). The ${PLAN_NAMES[plan]} plan supports up to ${limitKb}KB (${charLimit.toLocaleString()} characters).`,
        hint: UPGRADE_HINTS[plan],
        upgrade: plan !== "team",
        charLimit,
        programLength
      });
    }

    // Hard server-side cap regardless of plan (safety net)
    if (prompt.length > 200000) {
      return res.status(400).json({ error: "Request too large. Maximum 200,000 characters total." });
    }

    // ── 4. CALL CLAUDE API ────────────────────────────────────────────
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const message = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }]
    });

    const result = message.content.map(b => b.type === "text" ? b.text : "").join("");

    // ── 5. INCREMENT USAGE (on last of 4 calls = "modern" type) ───────
    if (analysisType === "modern") {
      await sb.from("usage").upsert({
        user_id:    user.id,
        month_key:  monthKey,
        count:      currentCount + 1,
        updated_at: new Date().toISOString()
      }, { onConflict: "user_id,month_key" });
    }

    return res.status(200).json({ result });

  } catch (err) {
    console.error("Proxy error:", err);

    if (err.status === 401) return res.status(502).json({ error: "Invalid Anthropic API key on server. Contact support." });
    if (err.status === 429) return res.status(429).json({ error: "AI service rate limited. Please wait 30 seconds and try again." });
    if (err.status === 529) return res.status(503).json({ error: "AI service overloaded. Please try again in a moment." });

    return res.status(500).json({ error: "Analysis failed. Please try again." });
  }
}
