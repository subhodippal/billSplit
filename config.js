/* SplitEasy configuration.
   Fill these in from Supabase Dashboard → Project Settings → API to turn on
   accounts, cloud storage and real-time sharing. Leave them empty and the app
   runs in offline mode, saving splits on this device only.
   The anon (public) key is safe to ship in the browser: access is enforced by
   the row-level security rules in supabase/schema.sql. */

window.SPLITEASY_CONFIG = {
  supabaseUrl: 'https://knhhgslvuyiqaotlyvez.supabase.co', // OneDB
  // Optional: Google Maps Platform key with "Places API (New)" enabled, restricted to your site's
  // URLs (HTTP referrers). Empty = free OpenStreetMap suggestions instead.
  googleMapsKey: '',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtuaGhnc2x2dXlpcWFvdGx5dmV6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE5NjM0MjgsImV4cCI6MjEwNzUzOTQyOH0.XNXJ9SlMVDRGeZ_usuqU27TGHA26l-UGjHVVz4PUgQ0'
};
