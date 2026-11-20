/* Posie configuration.
 * Fill these in to turn on "Sign in with Apple" + sync (see SETUP.md).
 * The anon key is designed to be public: Row Level Security keeps every board private.
 */
window.POSIE_CONFIG = {
  supabaseUrl: 'https://arnpmovrwyceifulfmzd.supabase.co',
  supabaseAnonKey: '',  // Project Settings → API Keys → anon / publishable key
  appleSignIn: false,   // turn on once Sign in with Apple is set up (needs the paid Apple Developer Program)
};
