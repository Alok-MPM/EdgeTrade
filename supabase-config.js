const SUPA_URL = 'https://ucwgvvsnellchioltkxs.supabase.co';
const SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVjd2d2dnNuZWxsY2hpb2x0a3hzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAwODEyOTYsImV4cCI6MjA5NTY1NzI5Nn0.goU5F94rJcih_Nv8Gqp0xR7LjAH8n3zqp8qtLYLQPZM';
const { createClient } = supabase;
const db = createClient(SUPA_URL, SUPA_KEY);
