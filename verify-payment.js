import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://rpglens.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // ── Auth ──────────────────────────────────────────────────────────
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Not authenticated' });

    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data: { user }, error: authError } = await sb.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: 'Session expired.' });

    const { razorpay_payment_id, razorpay_subscription_id, razorpay_signature, plan } = req.body;

    if (!razorpay_payment_id || !razorpay_subscription_id || !razorpay_signature) {
      return res.status(400).json({ error: 'Missing payment details.' });
    }

    // ── Verify Razorpay signature ─────────────────────────────────────
    const body = razorpay_payment_id + '|' + razorpay_subscription_id;
    const expectedSig = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest('hex');

    if (expectedSig !== razorpay_signature) {
      console.error('Signature mismatch:', { expected: expectedSig, received: razorpay_signature });
      return res.status(400).json({ error: 'Payment verification failed. Please contact support.' });
    }

    // ── Update user plan in Supabase ──────────────────────────────────
    await sb.auth.admin.updateUserById(user.id, {
      user_metadata: {
        ...user.user_metadata,
        plan,
        razorpay_subscription_id,
        plan_activated_at: new Date().toISOString()
      }
    });

    await sb.from('profiles').upsert({
      id:                       user.id,
      email:                    user.email,
      plan,
      razorpay_subscription_id,
      pending_plan:             null,
      plan_activated_at:        new Date().toISOString(),
      updated_at:               new Date().toISOString()
    }, { onConflict: 'id' });

    return res.status(200).json({ success: true, plan });

  } catch (err) {
    console.error('verify-payment error:', err);
    return res.status(500).json({ error: err.message || 'Verification failed.' });
  }
}
