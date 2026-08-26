const DEFAULT_REMINDER_MINUTES = 10;
const MIN_REMINDER_MINUTES = 1;
const MAX_REMINDER_MINUTES = 1440;

function normalizeReminderMinutes(value) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes)) return DEFAULT_REMINDER_MINUTES;
  return Math.max(MIN_REMINDER_MINUTES, Math.min(MAX_REMINDER_MINUTES, Math.round(minutes)));
}

function normalizeReminderTasks(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap(task => {
    if (!task || typeof task !== 'object' || typeof task.id !== 'string' || !task.id) return [];
    const dueAt = Date.parse(typeof task.due === 'string' ? task.due : '');
    if (!Number.isFinite(dueAt)) return [];
    return [{
      id: task.id.slice(0, 160),
      categoryId: typeof task.categoryId === 'string' ? task.categoryId.slice(0, 160) : '',
      title: typeof task.title === 'string' && task.title.trim() ? task.title.trim().slice(0, 60) : '未命名任务',
      dueAt,
      done: Boolean(task.done)
    }];
  });
}

const reminderKey = task => `${task.id}\0${task.dueAt}`;

function collectDueReminders(tasks, notifiedKeys, now = Date.now(), reminderMinutes = DEFAULT_REMINDER_MINUTES) {
  const leadMs = normalizeReminderMinutes(reminderMinutes) * 60 * 1000;
  return tasks.filter(task => {
    const remaining = task.dueAt - now;
    return !task.done && remaining > 0 && remaining <= leadMs && !notifiedKeys.has(reminderKey(task));
  });
}

module.exports = { DEFAULT_REMINDER_MINUTES, MIN_REMINDER_MINUTES, MAX_REMINDER_MINUTES, normalizeReminderMinutes, normalizeReminderTasks, reminderKey, collectDueReminders };
