alter table notifications alter column status set default 'pending';

update notifications
set status = delivery_status::notification_status
where status::text <> delivery_status;
