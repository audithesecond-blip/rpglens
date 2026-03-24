import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

export const config = { api: { bodyParser: { sizeLimit: '4mb' } } };

const PLAN_LIMITS = { free: 3, starter: 25, team: 150, admin: 999999 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://rpglens.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // ── Auth ─────────────────────────────────────────────────────────
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Not authenticated' });

    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data: { user }, error: authError } = await sb.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: 'Session expired. Please sign in again.' });

    const plan = user.user_metadata?.plan || 'free';
    const limit = PLAN_LIMITS[plan] || 3;

    // ── Usage check ───────────────────────────────────────────────────
    if (plan !== 'admin') {
      const periodStart = new Date();
      periodStart.setDate(periodStart.getDate() - 30);

      const { count } = await sb
        .from('usage')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .gte('created_at', periodStart.toISOString());

      if (count >= limit) {
        return res.status(429).json({
          error: `You have used all ${limit} analyses in your current billing period.`,
          upgrade: plan !== 'team'
        });
      }
    }

    const { tddText, projectName, components } = req.body;
    if (!tddText || tddText.trim().length < 50) {
      return res.status(400).json({ error: 'TDD content is too short.' });
    }

    // ── Generate code ─────────────────────────────────────────────────
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const componentList = components && components.length
      ? `Generate only these components: ${components.join(', ')}`
      : 'Generate all applicable components.';

    const prompt = `You are a senior IBM i RPG developer. Based on the Technical Design Document below, generate production-ready IBM i source code skeletons.

Project: ${projectName || 'Unnamed Project'}
${componentList}

TDD:
${tddText}

Generate each component as a separate clearly labelled section. For each component:

1. Start with a header line: === COMPONENT: [name] | TYPE: [RPGLE/CLLE/DSPF/PRTF/PF/LF] ===
2. Provide complete, compilable source code skeleton
3. Include all H-specs/Control specs
4. Include all F-specs with actual file names from the TDD
5. Include D-specs / DCL-S / DCL-DS for all data structures from TDD
6. Include the full program structure with all subroutines/procedures stubbed out
7. Add inline comments explaining each section
8. Use free-format ILE RPG (not fixed format) for RPG programs
9. Use proper IBM i naming conventions (max 10 chars for objects)
10. Include proper error handling with MONITOR/ON-ERROR blocks

For DDS files (PF/LF):
- Include all fields with proper types and lengths from the TDD
- Include key fields
- Include field-level text descriptions

For CL programs:
- Include proper PGM/ENDPGM structure
- DCLF, DCL variables
- MONMSG handlers
- SBMJOB calls where applicable

End each component with: === END: [name] ===

Make the code genuinely useful — not just comments. Stub procedures should have proper prototypes, data structures should have real field names, file specs should reference real files.`;

    const response = await client.messages.create({
      model:      'claude-opus-4-5',
      max_tokens: 8000,
      messages:   [{ role: 'user', content: prompt }]
    });

    const generatedCode = response.content[0].text;

    // ── Parse components from response ────────────────────────────────
    const componentRegex = /=== COMPONENT: (.+?) \| TYPE: (.+?) ===([\s\S]*?)=== END: .+? ===/g;
    const parsedComponents = [];
    let match;
    while ((match = componentRegex.exec(generatedCode)) !== null) {
      parsedComponents.push({
        name: match[1].trim(),
        type: match[2].trim(),
        code: match[3].trim()
      });
    }

    // ── Log usage ─────────────────────────────────────────────────────
    await sb.from('usage').insert({
      user_id:    user.id,
      type:       'analysis',
      subtype:    'tdd-code',
      created_at: new Date().toISOString()
    });

    return res.status(200).json({
      raw:        generatedCode,
      components: parsedComponents,
      projectName: projectName || 'Unnamed Project'
    });

  } catch (err) {
    console.error('tdd-code error:', err);
    return res.status(500).json({ error: err.message || 'Failed to generate code.' });
  }
}
