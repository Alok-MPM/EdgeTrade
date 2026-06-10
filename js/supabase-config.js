const SUPA_URL = 'https://ucwgvvsnellchioltkxs.supabase.co';
const SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'; // Apni poori anon key daal dena yahan

const supabase = supabase.createClient(SUPA_URL, SUPA_KEY);
const db = supabase; 
