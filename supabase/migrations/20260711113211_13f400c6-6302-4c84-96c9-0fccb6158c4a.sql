
-- All signed-in users can view avatars (needed to show teammates' photos).
CREATE POLICY "Authenticated can read avatars"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'avatars');

-- Each user can only write/replace/delete objects under their own user id folder.
CREATE POLICY "Users manage own avatar"
  ON storage.objects FOR ALL TO authenticated
  USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text)
  WITH CHECK (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text);
