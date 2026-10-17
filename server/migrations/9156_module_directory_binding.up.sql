ALTER TABLE module ADD COLUMN directory_name text;
UPDATE module m SET directory_name = title
WHERE title NOT IN ('', '.', '..') AND octet_length(title) <= 240
  AND title !~ E'[/\\\\[:cntrl:]]'
  AND NOT EXISTS (SELECT 1 FROM module other WHERE other.project_id=m.project_id AND other.id<>m.id AND lower(other.title)=lower(m.title));
