ALTER TABLE company_projects
  ADD COLUMN selected_skill_ids_json TEXT NOT NULL DEFAULT '[]'
  CHECK (length(selected_skill_ids_json) > 0);
