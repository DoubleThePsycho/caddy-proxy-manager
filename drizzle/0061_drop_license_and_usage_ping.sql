-- Ingressi needs no license and sends no usage ping any more: the installed
-- key, its online check state, the install id it sent, the automatic update
-- settings (with the refresh token) and the usage ping settings are deleted.
DELETE FROM `settings` WHERE `key` IN ('license', 'license_check', 'license_install_id', 'license_auto_update', 'license_auto_update_state', 'usage_ping', 'usage_ping_state');
