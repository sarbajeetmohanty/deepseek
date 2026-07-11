-- Lock down SECURITY DEFINER function execution.
-- handle_new_user() only runs from the auth.users insert trigger; nobody should call it via the API.
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;

-- has_role() is used inside RLS policies; keep it callable by the roles that own those policies,
-- but remove the broad PUBLIC/anon grants so it isn't callable without a session.
REVOKE EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO authenticated, service_role;