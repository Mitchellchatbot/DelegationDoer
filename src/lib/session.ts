// Hardcoded "logged-in user" until real auth is wired up. Lives outside
// mock-data.ts so backend code can import it without pulling in the in-memory
// user/ticket arrays. The id refers to a real row in public.users.
export const CURRENT_USER_ID = "u_1";
