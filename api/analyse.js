import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";

// ── PLAN LIMITS ───────────────────────────────────────────────────────
const ANALYSIS_LIMITS        = { free: 3,     starter: 25,     team: 150,    admin: 999999 };
const CONVERSION_LIMITS      = { free: 1,     starter: 5,      team: 20,     admin: 999999 };
const CHAR_LIMITS            = { free: 30000, starter: 100000, team: 300000, admin: 999999 };
const CONVERSION_LINE_LIMITS = { free: 500,   starter: 1000,   team: 2000,   admin: 999999 };

const PLAN_NAMES = { free: "Free", starter: "Starter", team: "Team", admin: "Admin" };

const CONV_UPGRADE_HINTS = {
  free:    "Upgrade to Starter (₹2,999/mo) for 5 conversions/month up to 1,000 lines.",
  starter: "Upgrade to Team (₹9,999/mo) for 20 conversions/month up to 2,000 lines.",
  team:    "Contact us for Enterprise with unlimited conversions.",
  admin:   ""
};

const ANALYSIS_UPGRADE_HINTS = {
  free:    "Upgrade to Starter (₹2,999/mo) to analyse programs up to 100,000 characters.",
  starter: "Upgrade to Team (₹9,999/mo) for 150 analyses/month.",
  team:    "Contact us for Enterprise.",
  admin:   ""
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "https://rpglens.vercel.app");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "Method not allowed" });

  try {
    // ── 1. AUTHENTICATE ───────────────────────────────────────────────
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Not authenticated. Please sign in." });
    }
    const token = authHeader.split(" ")[1];
    const sb    = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    const { data: { user }, error: authError } = await sb.auth.getUser(token);
    if (authError || !user) {
      return res.status(401).json({ error: "Session expired. Please sign in again." });
    }

    // ── 2. ROLLING 30-DAY PERIOD ──────────────────────────────────────
    const plan         = user.user_metadata?.plan || "free";
    const signupDate   = new Date(user.created_at);
    const now          = new Date();
    const daysSince    = Math.floor((now - signupDate) / (1000 * 60 * 60 * 24));
    const periodNumber = Math.floor(daysSince / 30);
    const periodStart  = new Date(signupDate.getTime() + periodNumber * 30 * 24 * 60 * 60 * 1000);
    const periodEnd    = new Date(periodStart.getTime() + 30 * 24 * 60 * 60 * 1000);
    const monthKey     = `period_${periodNumber}`;
    const resetLabel   = periodEnd.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });

    const { prompt, analysisType, codeLength, lineCount } = req.body;
    const isConversion  = analysisType === "convert" || analysisType === "convert_chunk";
    const isFirstChunk  = analysisType === "convert";

    // ── 3. VALIDATE PROMPT ────────────────────────────────────────────
    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ error: "No code provided." });
    }
    if (prompt.length > 300000) {
      return res.status(400).json({ error: "Request too large. Maximum 300,000 characters." });
    }

    // ── 4. ENFORCE LIMITS ─────────────────────────────────────────────
    if (isConversion && isFirstChunk && plan !== "admin") {

      // 4a. Line count limit
      const lineLimit = CONVERSION_LINE_LIMITS[plan] || 500;
      const lines     = lineCount || 0;
      if (lines > lineLimit) {
        return res.status(413).json({
          error:     `Program too large for conversion on your ${PLAN_NAMES[plan]} plan. Your program has ${lines.toLocaleString()} lines. ${PLAN_NAMES[plan]} supports up to ${lineLimit.toLocaleString()} lines.`,
          hint:      CONV_UPGRADE_HINTS[plan],
          upgrade:   plan !== "team",
          lineLimit,
          lineCount: lines,
          type:      "line_limit"
        });
      }

      // 4b. Conversion count limit
      const convLimit = CONVERSION_LIMITS[plan] || 1;
      const { data: convData } = await sb
        .from("conversions").select("count")
        .eq("user_id", user.id).eq("month_key", monthKey).single();
      const convCount = convData?.count || 0;

      if (convCount >= convLimit) {
        return res.status(429).json({
          error:     `Conversion limit reached. You have used ${convCount} of ${convLimit} conversions this period. Resets on ${resetLabel}.`,
          hint:      CONV_UPGRADE_HINTS[plan],
          upgrade:   plan !== "team",
          resetDate: periodEnd.toISOString(),
          type:      "conversion_limit"
        });
      }

    } else if (!isConversion && plan !== "admin") {

      // 4c. Character limit
      const charLimit     = CHAR_LIMITS[plan] || 30000;
      const programLength = codeLength || prompt.length;
      if (programLength > charLimit) {
        const kb = Math.round(programLength / 1000);
        return res.status(413).json({
          error:   `Program too large for your ${PLAN_NAMES[plan]} plan (~${kb}KB). ${PLAN_NAMES[plan]} supports up to ${Math.round(charLimit/1000)}KB.`,
          hint:    ANALYSIS_UPGRADE_HINTS[plan],
          upgrade: plan !== "team",
          charLimit,
          programLength
        });
      }

      // 4d. Analysis count limit
      const analysisLimit = ANALYSIS_LIMITS[plan] || 3;
      const { data: usageData } = await sb
        .from("usage").select("count")
        .eq("user_id", user.id).eq("month_key", monthKey).single();
      const usageCount = usageData?.count || 0;

      if (usageCount >= analysisLimit) {
        return res.status(429).json({
          error:     `Monthly limit reached. You have used ${usageCount} of ${analysisLimit} analyses this period. Resets on ${resetLabel}.`,
          hint:      ANALYSIS_UPGRADE_HINTS[plan],
          upgrade:   plan !== "team",
          resetDate: periodEnd.toISOString(),
          type:      "analysis_limit"
        });
      }
    }

    // ── 5. CALL CLAUDE API ────────────────────────────────────────────
    const client    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const maxTokens = isConversion ? 16000 : 1500;

    const message = await client.messages.create({
      model:      "claude-sonnet-4-20250514",
      max_tokens: maxTokens,
      messages:   [{ role: "user", content: prompt }]
    });

    const result     = message.content.map(b => b.type === "text" ? b.text : "").join("");
    const stopReason = message.stop_reason;

    // ── 6. INCREMENT USAGE ────────────────────────────────────────────
    if (plan !== "admin") {
      if (isFirstChunk) {
        // One conversion credit per full conversion (not per chunk)
        const { data: existing } = await sb
          .from("conversions").select("count")
          .eq("user_id", user.id).eq("month_key", monthKey).single();
        await sb.from("conversions").upsert({
          user_id:    user.id,
          month_key:  monthKey,
          count:      (existing?.count || 0) + 1,
          updated_at: now.toISOString()
        }, { onConflict: "user_id,month_key" });

      } else if (!isConversion) {
        // One analysis credit per API call
        const { data: existing } = await sb
          .from("usage").select("count")
          .eq("user_id", user.id).eq("month_key", monthKey).single();
        await sb.from("usage").upsert({
          user_id:    user.id,
          month_key:  monthKey,
          count:      (existing?.count || 0) + 1,
          updated_at: now.toISOString()
        }, { onConflict: "user_id,month_key" });
      }
    }

    return res.status(200).json({
      result,
      stopReason,
      periodEnd: periodEnd.toISOString(),
      monthKey
    });

  } catch (err) {
    console.error("Proxy error:", err);
    if (err.status === 401) return res.status(502).json({ error: "Invalid Anthropic API key. Contact support." });
    if (err.status === 429) return res.status(429).json({ error: "AI service rate limited. Please wait 30 seconds." });
    if (err.status === 529) return res.status(503).json({ error: "AI service overloaded. Please try again." });
    return res.status(500).json({ error: "Analysis failed. Please try again." });
  }
}
