ALTER TABLE browser_profile_startups DROP CONSTRAINT browser_profile_startups_state_check;
ALTER TABLE browser_profile_startups ADD CONSTRAINT browser_profile_startups_state_check
  CHECK(state IN ('PREPARING','LOADING','NAVIGATING','STARTED','READY','FAILED','UNKNOWN'));
