-- Per-user override for the desktop widget bubble image. NULL = use the
-- shared brand logo at /widget-icon.png. When set, the widget renders
-- this image on the bubble + the panel header.
alter table users
  add column if not exists widget_icon_url text;
