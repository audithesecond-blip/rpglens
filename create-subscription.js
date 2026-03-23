import Razorpay from 'razorpay';
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
    if (authError || !user) return res.status(401).json({ error: 'Session expired. Please sign in again.' });

    // ── Plan selection ────────────────────────────────────────────────
    const { plan } = req.body;
    const planIds = {
      starter: process.env.RAZORPAY_STARTER_PLAN_ID,
      team:    process.env.RAZORPAY_TEAM_PLAN_ID
    };
    const planId = planIds[plan];
    if (!planId) return res.status(400).json({ error: 'Invalid plan selected.' });

    // Don't allow downgrade via this endpoint
    const currentPlan = user.user_metadata?.plan || 'free';
    if (currentPlan === plan) return res.status(400).json({ error: `You are already on the ${plan} plan.` });

    // ── Create Razorpay subscription ──────────────────────────────────
    const rzp = new Razorpay({
      key_id:     process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET
    });

    const subscription = await rzp.subscriptions.create({
      plan_id:         planId,
      customer_notify: 1,
      total_count:     120, // 10 years — effectively indefinite
      notes: {
        user_id: user.id,
        email:   user.email,
        plan
      }
    });

    // Store pending subscription in profiles table
    await sb.from('profiles').upsert({
      id:                       user.id,
      email:                    user.email,
      razorpay_subscription_id: subscription.id,
      pending_plan:             plan,
      updated_at:               new Date().toISOString()
    }, { onConflict: 'id' });

    return res.status(200).json({
      subscription_id: subscription.id,
      key_id:          process.env.RAZORPAY_KEY_ID,
      email:           user.email,
      name:            user.user_metadata?.full_name || user.user_metadata?.name || user.email.split('@')[0],
      plan
    });

  } catch (err) {
    console.error('create-subscription error:', err);
    return res.status(500).json({ error: err.message || 'Failed to create subscription. Please try again.' });
  }
}
