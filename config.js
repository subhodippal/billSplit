/* SplitEasy configuration.
   Fill these in from Supabase Dashboard → Project Settings → API to turn on
   accounts, cloud storage and real-time sharing. Leave them empty and the app
   runs in offline mode, saving splits on this device only.
   The anon (public) key is safe to ship in the browser: access is enforced by
   the row-level security rules in supabase/schema.sql. */

window.SPLITEASY_CONFIG = {
  supabaseUrl: 'https://fzmdrfmcszehkscbzkhl.supabase.co',
  // Optional: Google Maps Platform key with "Places API (New)" enabled, restricted to your site's
  // URLs (HTTP referrers). Empty = free OpenStreetMap suggestions instead.
  googleMapsKey: '',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ6bWRyZm1jc3plaGtzY2J6a2hsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTEwOTA2MTIsImV4cCI6MjEwNjY2NjYxMn0.7qRnBKYwhiZyoyWv0HTLsb7KZz5eHWva_cPkphdavjE'
};
