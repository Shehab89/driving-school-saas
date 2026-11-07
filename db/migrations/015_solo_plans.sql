-- Plans in line with the pricing study (PRICING.md, 6 Nov 2026).
-- Most Dutch schools are one instructor, so the first plan is "Solo":
-- unlimited students and the WhatsApp AI assistant included (the feature
-- competitors don't have). Codes stay the same so existing schools keep
-- their subscription; only names, prices and limits change.
UPDATE plans SET name = 'Solo (1 instructor, WhatsApp assistant included)', monthly_price_cents = 3900,
       max_instructors = 1, max_active_students = NULL,
       features = '{"whatsapp_ai": true, "stripe": true, "solo_app": true}'
 WHERE code = 'starter';
UPDATE plans SET name = 'Team (up to 5 instructors)', monthly_price_cents = 6400,
       max_instructors = 5, max_active_students = NULL,
       features = '{"whatsapp_ai": true, "stripe": true, "reports": true}'
 WHERE code = 'team';
-- School: 15 instructors in the price, more are billed at +€7 each, so no hard cap.
UPDATE plans SET name = 'School (15 instructors, +€7 per extra)', monthly_price_cents = 11400,
       max_instructors = NULL, max_active_students = NULL,
       features = '{"whatsapp_ai": true, "stripe": true, "reports": true, "priority_support": true}'
 WHERE code = 'business';
