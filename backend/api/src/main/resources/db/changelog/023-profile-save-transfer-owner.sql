CREATE UNIQUE INDEX profile_version_one_save_transfer ON profile_transfers(version_id)
  WHERE direction='SAVE';
