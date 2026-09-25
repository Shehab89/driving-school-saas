INSERT INTO plans (code, name, monthly_price_cents, currency, max_instructors, max_active_students, features) VALUES
  ('starter',  'Starter (1 instructor)', 2900, 'EUR', 1,    60,   '{"whatsapp_ai": true, "stripe": true}'),
  ('team',     'Team (up to 5)',          7900, 'EUR', 5,    300,  '{"whatsapp_ai": true, "stripe": true, "reports": true}'),
  ('business', 'Business (unlimited)',   19900, 'EUR', NULL, NULL, '{"whatsapp_ai": true, "stripe": true, "reports": true, "priority_support": true}')
ON CONFLICT (code) DO NOTHING;
