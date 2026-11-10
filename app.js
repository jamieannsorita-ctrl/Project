/* ==========================================================================
   CLASP — Class Lineup And Schedule Planner
   app.js · ITP10 Event-Driven Programming

   Feature map
   1. Add class (form + validation)
   2. Weekly timetable (dynamic day/time grid)
   3. Conflict detection
   4. Edit / delete with confirmation
   5. Live search + day filter
   6. Auto-save to localStorage
   7. Print view
   8. Light / dark theme toggle
   9. Pop-up class reminders (flashing attention effect)
   ========================================================================== */

(function () {
  'use strict';

  /* Constants and state */
  const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const DAY_SHORT = Object.fromEntries(DAYS.map((day) => [day, day.slice(0, 3)]));
  const COLORS = ['#5B4BFF', '#0EA5E9', '#14B8A6', '#22C55E', '#F59E0B', '#F97316', '#EC4899', '#8B5CF6'];
  const STORAGE_KEY = 'clasp.schedule.v1';
  const THEME_KEY = 'clasp.theme';
  const REMINDER_LEAD_MINUTES = 10;   /* Pop up a reminder this many minutes before a class starts. */
  const REMINDER_SNOOZE_MINUTES = 5;  /* "Snooze" re-arms the pop-up for this many minutes. */
  const REMINDER_CHECK_MS = 15000;    /* How often to look for due reminders. */
  const REMINDER_STORE_KEY = 'clasp.reminders.v1';
  const REMINDER_TITLE_FLASH = '⏰ Class starting soon!';
  const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const es = (n) => (n === 1 ? '' : 'es');

  const SAMPLE_CLASSES = [
    { subject: 'Data Structures', day: 'Monday', start: '08:00', end: '09:30', room: 'Lab 204', instructor: 'Ms. Cruz', color: '#5B4BFF' },
    { subject: 'Web Systems', day: 'Monday', start: '10:00', end: '11:30', room: 'Room 301', instructor: 'Mr. Reyes', color: '#0EA5E9' },
    { subject: 'Discrete Mathematics', day: 'Tuesday', start: '09:00', end: '10:30', room: 'Room 210', instructor: 'Dr. Santos', color: '#14B8A6' },
    { subject: 'ITP10 Event-Driven Programming', day: 'Wednesday', start: '13:00', end: '15:00', room: 'Lab 105', instructor: 'Ms. Lanto', color: '#8B5CF6' },
    { subject: 'Physical Education', day: 'Thursday', start: '07:30', end: '09:00', room: 'Gymnasium', instructor: 'Coach Dela Cruz', color: '#F59E0B' },
    { subject: 'Purposive Communication', day: 'Friday', start: '10:00', end: '11:30', room: 'Room 112', instructor: 'Ms. Bautista', color: '#EC4899' },
    { subject: 'Capstone Project 1', day: 'Saturday', start: '09:00', end: '12:00', room: 'Lab 401', instructor: 'Mr. Aquino', color: '#22C55E' }
  ];

  let classes = [];
  let editingId = null;
  let pendingDeleteId = null;
  let conflictAcknowledged = false;
  let activeView = 'timetable';
  let toastTimer = null;

  /* Reminder feature state (see "Feature 9" below). */
  let reminderMemory = new Map(); /* occurrence key -> { dismissed, snoozedUntil } */
  let reminderActiveKey = null;
  let reminderActiveId = null;
  let reminderTicker = null;
  let reminderTitleTimer = null;
  let reminderBaseTitle = null;
  let reminderCloseHandled = false;

  const filters = { query: '', day: 'all' };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  const els = Object.fromEntries(
    [
      'timetable', 'timetableScroll', 'ttEmpty', 'ttSummary', 'conflictChip', 'conflictChipText',
      'weekLabel', 'navCount', 'statClasses', 'statHours', 'statBusiest', 'statBusiestHint',
      'statConflicts', 'statConflictsHint', 'searchInput', 'dayChips', 'resultCount', 'classList',
      'classDialog', 'classForm', 'dialogTitle', 'dialogSubtitle', 'subject', 'day', 'start', 'end',
      'room', 'instructor', 'colorPicker', 'conflictWarning', 'conflictList', 'saveBtn', 'deleteBtn',
      'confirmDialog', 'confirmMessage', 'confirmDeleteBtn', 'saveStatus',
      'saveStatusText', 'themeToggle', 'toast', 'printDate', 'printBtn', 'noticeDialog',
      'noticeTitle', 'noticeSubtitle', 'noticeMessage', 'printTitle', 'printScope',
      'reminderDialog', 'reminderDetails', 'reminderSubject', 'reminderWhen', 'reminderRoom',
      'reminderInstructor', 'reminderCountdown', 'reminderSnoozeBtn', 'reminderDismissBtn',
      'reminderHint'
    ].map((id) => [id, $('#' + id)])
  );

  /* Small helpers */
  const uid = () =>
    window.crypto && typeof window.crypto.randomUUID === 'function'
      ? window.crypto.randomUUID()
      : 'cls-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);

  const toMinutes = (time) => {
    const [hours, minutes] = String(time).split(':');
    return Number(hours) * 60 + Number(minutes);
  };

  const formatTime = (time) => {
    const total = toMinutes(time);
    const hours24 = Math.floor(total / 60) % 24;
    return (hours24 % 12 || 12) + ':' + String(total % 60).padStart(2, '0') + ' ' + (hours24 >= 12 ? 'PM' : 'AM');
  };

  const formatHour = (minutes) => {
    const hours24 = Math.floor(minutes / 60) % 24;
    return (hours24 % 12 || 12) + ' ' + (hours24 >= 12 ? 'PM' : 'AM');
  };

  const formatRange = (start, end) => `${formatTime(start)} – ${formatTime(end)}`;

  const formatDuration = (minutes) => {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return hours && rest ? `${hours}h ${rest}m` : hours ? `${hours}h` : `${rest}m`;
  };

  const escapeHtml = (value) =>
    String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ESC[char]);

  const normalizeColor = (color) => (COLORS.includes(color) ? color : COLORS[0]);

  const formatDateShort = (date) => date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  const sameDate = (a, b) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

  /** Monday–Saturday dates for the current (or upcoming) school week. */
  const getWeekDates = () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const monday = new Date(today);
    monday.setDate(today.getDate() + (today.getDay() === 0 ? 1 : 1 - today.getDay()));
    return DAYS.map((_day, index) => {
      const date = new Date(monday);
      date.setDate(monday.getDate() + index);
      return date;
    });
  };

  /* Feature 6: persistence (loadData / saveData) */
  const isValidClass = (item) =>
    item &&
    typeof item.subject === 'string' &&
    item.subject.trim() !== '' &&
    DAYS.includes(item.day) &&
    TIME_PATTERN.test(item.start) &&
    TIME_PATTERN.test(item.end) &&
    toMinutes(item.end) > toMinutes(item.start);

  const normalizeClass = (item) => ({
    id: (typeof item.id === 'string' && item.id) || uid(),
    subject: String(item.subject).trim().slice(0, 60),
    day: item.day,
    start: item.start,
    end: item.end,
    room: typeof item.room === 'string' ? item.room.trim().slice(0, 30) : '',
    instructor: typeof item.instructor === 'string' ? item.instructor.trim().slice(0, 50) : '',
    color: normalizeColor(item.color)
  });

  const loadData = () => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        classes = [];
        return;
      }
      const parsed = JSON.parse(raw);
      classes = Array.isArray(parsed) ? parsed.filter(isValidClass).map(normalizeClass) : [];
    } catch (error) {
      console.error('CLASP: could not read the saved schedule.', error);
      classes = [];
      showToast('Could not read saved data. Starting with an empty schedule.', 'error');
    }
  };

  const saveData = () => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(classes));
      setSaveStatus('saved');
    } catch (error) {
      console.error('CLASP: could not save the schedule.', error);
      setSaveStatus('error');
      showToast('Your browser blocked local saving. Changes will be lost on refresh.', 'error');
    }
  };

  const setSaveStatus = (state) => {
    if (!els.saveStatus) return;
    els.saveStatus.dataset.state = state;
    els.saveStatusText.textContent = state === 'error' ? 'Not saved' : 'Saved locally';
    els.saveStatus.title = state === 'error' ? 'Local storage is unavailable' : 'Saved in this browser';
    if (state === 'saved') {
      els.saveStatus.classList.remove('is-flash');
      void els.saveStatus.offsetWidth;
      els.saveStatus.classList.add('is-flash');
    }
  };

  /* Conflict helpers (feature 3) */
  const detectConflict = (candidate) =>
    classes.filter((item) =>
      item.id !== candidate.id &&
      item.day === candidate.day &&
      toMinutes(candidate.start) < toMinutes(item.end) &&
      toMinutes(item.start) < toMinutes(candidate.end)
    );

  const getConflictIds = () => {
    const conflicting = new Set();
    for (let i = 0; i < classes.length; i += 1) {
      for (let j = i + 1; j < classes.length; j += 1) {
        const a = classes[i];
        const b = classes[j];
        if (a.day !== b.day) continue;
        if (toMinutes(a.start) < toMinutes(b.end) && toMinutes(b.start) < toMinutes(a.end)) {
          conflicting.add(a.id);
          conflicting.add(b.id);
        }
      }
    }
    return conflicting;
  };

  const showNotice = (title, subtitle, message) => {
    els.noticeTitle.textContent = title;
    els.noticeSubtitle.textContent = subtitle;
    els.noticeMessage.textContent = message;
    if (!els.noticeDialog.open) els.noticeDialog.showModal();
  };

  /* Toast + theme */
  const showToast = (message, type) => {
    if (!els.toast) return;
    els.toast.textContent = message;
    els.toast.dataset.type = type || 'success';
    els.toast.classList.add('is-visible');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => els.toast.classList.remove('is-visible'), 3400);
  };

  const applyTheme = (theme) => {
    const next = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    els.themeToggle?.setAttribute('aria-label', next === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
  };

  const toggleTheme = () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch (error) {
      /* Theme still applies for this visit even if storage is blocked. */
    }
  };

  /* Navigation */
  const setView = (view) => {
    activeView = view === 'classes' ? 'classes' : 'timetable';
    $$('.nav-btn').forEach((button) => {
      const isActive = button.dataset.view === activeView;
      button.classList.toggle('is-active', isActive);
      button.setAttribute('aria-pressed', String(isActive));
    });
    $('#view-timetable').hidden = activeView !== 'timetable';
    $('#view-classes').hidden = activeView !== 'classes';

    /* Printing is a timetable feature only. */
    els.printBtn.disabled = activeView === 'classes';
    els.printBtn.title = activeView === 'classes'
      ? 'Printing is available on the Timetable tab'
      : 'Print your schedule';

    if (activeView === 'classes' && classes.length === 0) {
      showNotice(
        'My classes is empty',
        'You have no saved classes yet.',
        'Add your first class to start building your weekly lineup.'
      );
    }
  };

  /* Feature 2: weekly timetable rendering */
  const getTimeRange = () => {
    let start = 7 * 60;
    let end = 19 * 60;
    classes.forEach((item) => {
      start = Math.min(start, Math.floor(toMinutes(item.start) / 60) * 60);
      end = Math.max(end, Math.ceil(toMinutes(item.end) / 60) * 60);
    });
    if (end - start < 8 * 60) end = Math.min(24 * 60, start + 8 * 60);
    return { start, end };
  };

  /**
   * Places overlapping classes side by side.
   * Returns each class with `lane` and `lanes` (total lanes in its overlap cluster).
   */
  const layoutDay = (dayClasses) => {
    if (!dayClasses.length) return [];

    const sorted = dayClasses.slice().sort((a, b) =>
      toMinutes(a.start) - toMinutes(b.start) || toMinutes(a.end) - toMinutes(b.end)
    );

    const clusters = [];
    let current = [];
    let clusterEnd = -1;

    sorted.forEach((item) => {
      const start = toMinutes(item.start);
      if (current.length && start >= clusterEnd) {
        clusters.push(current);
        current = [];
        clusterEnd = -1;
      }
      current.push(item);
      clusterEnd = Math.max(clusterEnd, toMinutes(item.end));
    });
    if (current.length) clusters.push(current);

    const placed = [];
    clusters.forEach((cluster) => {
      const laneEnds = [];
      const assignments = cluster.map((item) => {
        let lane = laneEnds.findIndex((end) => toMinutes(item.start) >= end);
        if (lane === -1) {
          laneEnds.push(toMinutes(item.end));
          lane = laneEnds.length - 1;
        } else {
          laneEnds[lane] = toMinutes(item.end);
        }
        return { item, lane };
      });
      const lanes = laneEnds.length;
      assignments.forEach(({ item, lane }) => placed.push({ item, lane, lanes }));
    });
    return placed;
  };

  const renderTimetable = (conflictIds) => {
    const range = getTimeRange();
    const total = range.end - range.start;
    const previousScroll = els.timetableScroll ? els.timetableScroll.scrollLeft : 0;
    const weekDates = getWeekDates();
    const today = new Date();

    els.timetable.innerHTML = '';
    els.timetable.style.setProperty('--tt-hours', total / 60);

    /* Header: corner + six day heads */
    const head = document.createElement('div');
    head.className = 'tt-head';
    head.innerHTML = '<div class="tt-corner">Time</div>';

    DAYS.forEach((day, index) => {
      const count = classes.filter((item) => item.day === day).length;
      const headCell = document.createElement('div');
      headCell.className = 'tt-dayhead' + (sameDate(weekDates[index], today) ? ' is-today' : '');
      headCell.innerHTML =
        `<span class="dh-name">${DAY_SHORT[day]} <em>${weekDates[index].getDate()}</em></span>` +
        (count ? `<span class="dh-count" title="${count} class${es(count)}">${count}</span>` : '');
      head.appendChild(headCell);
    });

    /* Body: time labels + six day columns */
    const body = document.createElement('div');
    body.className = 'tt-body';

    const timeCol = document.createElement('div');
    timeCol.className = 'tt-timecol';
    for (let minute = range.start; minute < range.end; minute += 60) {
      const label = document.createElement('div');
      label.className = 'tt-hour';
      label.style.top = `${((minute - range.start) / total) * 100}%`;
      label.textContent = formatHour(minute);
      timeCol.appendChild(label);
    }
    body.appendChild(timeCol);

    DAYS.forEach((day, index) => {
      const column = document.createElement('div');
      column.className = 'tt-daycol' + (sameDate(weekDates[index], today) ? ' is-today' : '');
      column.dataset.day = day;

      const dayClasses = classes.filter((item) => item.day === day);
      layoutDay(dayClasses).forEach((placed) => {
        column.appendChild(makeClassBlock(placed, range, conflictIds.has(placed.item.id)));
      });

      body.appendChild(column);
    });

    els.timetable.appendChild(head);
    els.timetable.appendChild(body);

    if (els.timetableScroll) {
      els.timetableScroll.scrollLeft = previousScroll;
      els.timetableScroll.hidden = classes.length === 0;
    }
    els.ttEmpty.hidden = classes.length > 0;

    const totalMinutes = classes.reduce((sum, item) => sum + (toMinutes(item.end) - toMinutes(item.start)), 0);
    els.ttSummary.textContent = classes.length
      ? `${classes.length} class${es(classes.length)} · ${formatDuration(totalMinutes)} scheduled`
      : 'No classes yet';
  };

  const makeClassBlock = (placed, range, hasConflict) => {
    const item = placed.item;
    const total = range.end - range.start;
    const start = toMinutes(item.start);
    const duration = toMinutes(item.end) - start;
    const topPercent = ((start - range.start) / total) * 100;
    const heightPercent = (duration / total) * 100;
    const widthPercent = 100 / placed.lanes;
    const isCompact = duration < 50 || placed.lanes > 2;
    const showMeta = !isCompact && placed.lanes === 1;
    const showRoom = showMeta && Boolean(item.room);
    const showInstructor = showMeta && Boolean(item.instructor);

    const block = document.createElement('button');
    block.type = 'button';
    block.className = 'class-block' + (isCompact ? ' is-compact' : '') + (hasConflict ? ' has-conflict' : '');
    block.dataset.id = item.id;
    block.style.setProperty('--c', item.color);
    block.style.top = `calc(${topPercent}% + 2px)`;
    block.style.height = `max(26px, calc(${heightPercent}% - 4px))`;
    block.style.left = `calc(${placed.lane * widthPercent}% + 3px)`;
    block.style.width = `calc(${widthPercent}% - 6px)`;
    block.title =
      `${item.subject} · ${formatRange(item.start, item.end)}` +
      `${item.instructor ? ` · ${item.instructor}` : ''}${hasConflict ? ' · Time conflict' : ''}`;
    block.setAttribute(
      'aria-label',
      `${item.subject}, ${item.day}, ${formatRange(item.start, item.end)}` +
      `${item.room ? `, ${item.room}` : ''}${item.instructor ? `, ${item.instructor}` : ''}` +
      `${hasConflict ? ', conflicts with another class' : ''}. Edit class.`
    );

    block.innerHTML =
      (hasConflict ? '<span class="cb-flag" aria-hidden="true">!</span>' : '') +
      `<span class="cb-subject">${escapeHtml(item.subject)}</span>` +
      (isCompact ? '' : `<span class="cb-meta">${formatRange(item.start, item.end)}</span>`) +
      (showRoom ? `<span class="cb-room">${escapeHtml(item.room)}</span>` : '') +
      (showInstructor ? `<span class="cb-instructor">${escapeHtml(item.instructor)}</span>` : '');

    block.addEventListener('click', () => openClassForm(item.id));

    return block;
  };

  /* Dashboard stats */
  const renderStats = (conflictIds) => {
    const totalMinutes = classes.reduce((sum, item) => sum + (toMinutes(item.end) - toMinutes(item.start)), 0);

    els.statClasses.textContent = classes.length;
    els.statHours.textContent = classes.length ? formatDuration(totalMinutes) : '0h';

    let busiest = null;
    DAYS.forEach((day) => {
      const count = classes.filter((item) => item.day === day).length;
      if (!busiest || count > busiest.count) busiest = { day, count };
    });

    if (busiest && busiest.count > 0) {
      els.statBusiest.textContent = DAY_SHORT[busiest.day];
      els.statBusiestHint.textContent = `${busiest.count} class${es(busiest.count)}`;
    } else {
      els.statBusiest.textContent = '—';
      els.statBusiestHint.textContent = 'No classes yet';
    }

    const conflictCount = conflictIds.size;
    els.statConflicts.textContent = conflictCount;
    els.statConflicts.classList.toggle('is-warn', conflictCount > 0);
    els.statConflictsHint.textContent = conflictCount ? 'Overlapping class times' : 'All clear';

    if (conflictCount) {
      els.conflictChip.dataset.state = 'warn';
      els.conflictChipText.textContent = `${conflictCount} class${es(conflictCount)} clash`;
    } else {
      els.conflictChip.dataset.state = 'ok';
      els.conflictChipText.textContent = 'No conflicts';
    }
  };

  /* Feature 5: search + day filter (class list) */
  const getFilteredClasses = () => {
    const query = filters.query.trim().toLowerCase();

    return classes
      .filter((item) => filters.day === 'all' || item.day === filters.day)
      .filter((item) => {
        if (!query) return true;
        const haystack = [item.subject, item.day, item.room, item.instructor, formatTime(item.start), formatTime(item.end)]
          .join(' ')
          .toLowerCase();
        return haystack.includes(query);
      })
      .sort((a, b) => DAYS.indexOf(a.day) - DAYS.indexOf(b.day) || toMinutes(a.start) - toMinutes(b.start));
  };

  const renderClassList = (conflictIds) => {
    const visible = getFilteredClasses();
    els.classList.innerHTML = '';

    if (!classes.length) {
      els.classList.innerHTML =
        '<div class="no-results"><h3>No classes yet</h3>' +
        '<p>Add your first class to start building your weekly lineup.</p>' +
        '<button class="btn btn-primary" type="button" data-action="add">+ Add your first class</button></div>';
      els.resultCount.textContent = 'No classes yet';
      return;
    }

    if (!visible.length) {
      els.classList.innerHTML =
        '<div class="no-results"><h3>No matching classes</h3>' +
        '<p>Try a different search term or day filter.</p>' +
        '<button class="btn btn-ghost" type="button" data-action="clear-filters">Clear filters</button></div>';
      els.resultCount.textContent = 'Showing 0 of ' + classes.length + ' classes';
      return;
    }

    const fragment = document.createDocumentFragment();
    visible.forEach((item) => fragment.appendChild(makeClassCard(item, conflictIds.has(item.id))));
    els.classList.appendChild(fragment);
    els.resultCount.textContent = `Showing ${visible.length} of ${classes.length} class${es(classes.length)}`;
  };

  const makeClassCard = (item, hasConflict) => {
    const card = document.createElement('article');
    card.className = 'class-card' + (hasConflict ? ' has-conflict' : '');
    card.style.setProperty('--c', item.color);

    card.innerHTML =
      '<div class="cc-head"><div class="cc-title"><span class="cc-dot" aria-hidden="true"></span>' +
      `<h3>${escapeHtml(item.subject)}</h3></div>` +
      (hasConflict ? '<span class="badge badge-danger">⚠ Conflict</span>' : '') +
      '</div><ul class="cc-meta">' +
      `<li><span class="meta-label">When</span><span class="meta-value">${DAY_SHORT[item.day]} · ${formatRange(item.start, item.end)}</span></li>` +
      `<li><span class="meta-label">Room</span><span class="meta-value${item.room ? '' : ' is-empty'}">${item.room ? escapeHtml(item.room) : 'Not set'}</span></li>` +
      `<li><span class="meta-label">Teacher</span><span class="meta-value${item.instructor ? '' : ' is-empty'}">${item.instructor ? escapeHtml(item.instructor) : 'Not set'}</span></li>` +
      '</ul><div class="cc-actions">' +
      `<button class="btn btn-ghost btn-sm" type="button" data-action="edit" data-id="${escapeHtml(item.id)}">Edit</button>` +
      `<button class="btn btn-danger-ghost btn-sm" type="button" data-action="delete" data-id="${escapeHtml(item.id)}">Delete</button>` +
      '</div>';

    return card;
  };

  const renderAll = () => {
    const conflictIds = getConflictIds();
    renderTimetable(conflictIds);
    renderClassList(conflictIds);
    renderStats(conflictIds);
    els.navCount.textContent = classes.length;
  };

  /* Feature 1 + 4: add / edit form */
  const renderColorPicker = () => {
    els.colorPicker.innerHTML = COLORS.map((color, index) =>
      `<label class="swatch" style="--c:${color}" title="Color ${index + 1}">` +
      `<input type="radio" name="color" value="${color}" aria-label="Class color ${index + 1}" />` +
      '<span class="swatch-dot" aria-hidden="true"></span></label>'
    ).join('');
  };

  const setSelectedColor = (color) => {
    const input = els.colorPicker.querySelector(`input[value="${normalizeColor(color)}"]`);
    if (input) input.checked = true;
  };

  const pickNextColor = () => {
    const usage = COLORS.map((color) => classes.filter((item) => item.color === color).length);
    let best = 0;
    usage.forEach((count, index) => {
      if (count < usage[best]) best = index;
    });
    return COLORS[best];
  };

  const setFieldError = (name, message) => {
    const input = els.classForm.elements[name];
    const error = $(`#err-${name}`);
    if (!input || !error) return;
    if (message) {
      input.setAttribute('aria-invalid', 'true');
      error.textContent = message;
    } else {
      input.removeAttribute('aria-invalid');
      error.textContent = '';
    }
  };

  const clearFieldErrors = () =>
    ['subject', 'day', 'start', 'end', 'room', 'instructor'].forEach((name) => setFieldError(name, ''));

  const hideConflictWarning = () => {
    els.conflictWarning.hidden = true;
    els.conflictList.innerHTML = '';
  };

  const showConflictWarning = (conflicts) => {
    els.conflictList.innerHTML = conflicts
      .map((item) => `<li><strong>${escapeHtml(item.subject)}</strong> — ${item.day}, ${formatRange(item.start, item.end)}</li>`)
      .join('');
    els.conflictWarning.hidden = false;
    els.conflictWarning.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };

  const setSaveButtonLabel = () => {
    els.saveBtn.textContent = editingId ? 'Save changes' : 'Save class';
    els.saveBtn.classList.remove('btn-warn');
  };

  const resetConflictState = () => {
    if (!conflictAcknowledged) return;
    conflictAcknowledged = false;
    hideConflictWarning();
    setSaveButtonLabel();
  };

  const openClassForm = (id) => {
    editingId = id || null;
    conflictAcknowledged = false;

    els.classForm.reset();
    clearFieldErrors();
    hideConflictWarning();
    setSaveButtonLabel();
    els.deleteBtn.hidden = true;

    if (editingId) {
      const item = classes.find((entry) => entry.id === editingId);
      if (!item) {
        editingId = null;
        return;
      }
      els.dialogTitle.textContent = 'Edit class';
      els.dialogSubtitle.textContent = 'Update the details below. Changes are saved automatically.';
      els.subject.value = item.subject;
      els.day.value = item.day;
      els.start.value = item.start;
      els.end.value = item.end;
      els.room.value = item.room;
      els.instructor.value = item.instructor;
      setSelectedColor(item.color);
      els.deleteBtn.hidden = false;
    } else {
      els.dialogTitle.textContent = 'Add class';
      els.dialogSubtitle.textContent = 'Fill in the details for your weekly class.';
      els.day.value = filters.day !== 'all' ? filters.day : 'Monday';
      setSelectedColor(pickNextColor());
    }

    els.classDialog.showModal();
    window.setTimeout(() => els.subject.focus(), 40);
  };

  const closeClassForm = () => {
    if (els.classDialog.open) els.classDialog.close();
    editingId = null;
    conflictAcknowledged = false;
  };

  const validateForm = () => {
    const data = {
      subject: els.subject.value.trim().replace(/\s+/g, ' '),
      day: els.day.value,
      start: els.start.value,
      end: els.end.value,
      room: els.room.value.trim(),
      instructor: els.instructor.value.trim(),
      color: els.classForm.querySelector('input[name="color"]:checked')?.value || COLORS[0]
    };

    let ok = true;

    if (!data.subject) {
      setFieldError('subject', 'Please enter the subject name.');
      ok = false;
    } else if (data.subject.length < 2) {
      setFieldError('subject', 'Use at least 2 characters.');
      ok = false;
    }

    if (!DAYS.includes(data.day)) {
      setFieldError('day', 'Please choose a day.');
      ok = false;
    }

    if (!data.start) {
      setFieldError('start', 'Please choose a start time.');
      ok = false;
    }

    if (!data.end) {
      setFieldError('end', 'Please choose an end time.');
      ok = false;
    }

    if (data.start && data.end) {
      const duration = toMinutes(data.end) - toMinutes(data.start);
      if (duration <= 0) {
        setFieldError('end', 'End time must be after the start time.');
        ok = false;
      } else if (duration < 15) {
        setFieldError('end', 'A class must be at least 15 minutes long.');
        ok = false;
      }
    }

    if (!ok) {
      const firstInvalid = els.classForm.querySelector('[aria-invalid="true"]');
      if (firstInvalid) firstInvalid.focus();
    }

    return { ok, data };
  };

  const handleSubmit = (event) => {
    event.preventDefault();

    const result = validateForm();
    if (!result.ok) {
      showToast('Please fix the highlighted fields.', 'error');
      return;
    }

    const wasEditing = Boolean(editingId);
    const candidate = { ...result.data, id: editingId || 'new' };
    const conflicts = detectConflict(candidate);

    if (conflicts.length && !conflictAcknowledged) {
      showConflictWarning(conflicts);
      conflictAcknowledged = true;
      els.saveBtn.textContent = 'Save anyway';
      els.saveBtn.classList.add('btn-warn');
      showToast(`This class overlaps with ${conflicts.length} existing class${es(conflicts.length)}.`, 'warn');
      return;
    }

    if (wasEditing) {
      const index = classes.findIndex((item) => item.id === editingId);
      if (index === -1) {
        closeClassForm();
        return;
      }
      classes[index] = { ...classes[index], ...result.data };
    } else {
      classes.push({ id: uid(), ...result.data });
    }

    saveData();
    closeClassForm();
    renderAll();

    if (conflicts.length) {
      showToast('Class saved — the time conflict is flagged on your timetable.', 'warn');
    } else {
      showToast(wasEditing ? 'Class updated.' : 'Class added to your timetable.', 'success');
    }
  };

  /* Feature 4: delete with confirmation */
  const requestDelete = (id) => {
    const item = classes.find((entry) => entry.id === id);
    if (!item) return;

    pendingDeleteId = id;
    els.confirmMessage.innerHTML =
      `<strong>${escapeHtml(item.subject)}</strong> (${item.day}, ${formatRange(item.start, item.end)}) ` +
      'will be removed from this device. This cannot be undone.';
    els.confirmDialog.showModal();
  };

  const deleteClass = (id) => {
    const item = classes.find((entry) => entry.id === id);
    if (!item) return;

    classes = classes.filter((entry) => entry.id !== id);
    saveData();

    if (editingId === id) closeClassForm();
    renderAll();
    showToast(`“${item.subject}” deleted.`, 'success');
  };

  /* Feature 5: search / filter handlers */
  const syncFilterChips = () => {
    $$('button[data-day]', els.dayChips).forEach((button) => {
      const isActive = button.dataset.day === filters.day;
      button.classList.toggle('is-active', isActive);
      button.setAttribute('aria-pressed', String(isActive));
    });
  };

  const searchClasses = () => {
    filters.query = els.searchInput.value;
    renderClassList(getConflictIds());
  };

  const filterByDay = (day) => {
    filters.day = DAYS.includes(day) ? day : 'all';
    syncFilterChips();
    renderClassList(getConflictIds());
  };

  const clearFilters = () => {
    filters.query = '';
    filters.day = 'all';
    els.searchInput.value = '';
    syncFilterChips();
    renderClassList(getConflictIds());
    els.searchInput.focus();
  };

  /* Feature 6 + extras: sample data, print, week label */
  const loadSample = () => {
    classes = SAMPLE_CLASSES.map((item) => ({ id: uid(), ...item }));
    saveData();
    renderAll();
    showToast('Sample schedule loaded — edit or delete classes to make it yours.', 'success');
  };

  const updateWeekLabel = () => {
    const dates = getWeekDates();
    els.weekLabel.textContent = `Week of ${formatDateShort(dates[0])} – ${formatDateShort(dates[5])}, ${dates[5].getFullYear()}`;
  };

  const updatePrintDetails = () => {
    const isClasses = activeView === 'classes';
    const day = filters.day === 'all' ? 'All days' : filters.day;
    const query = filters.query.trim();

    els.printTitle.textContent = isClasses ? 'My Classes' : 'My Weekly Class Schedule';
    els.printScope.textContent = isClasses
      ? `Showing: ${day}${query ? ` · Search: “${query}”` : ''}`
      : 'Full weekly timetable · All days';
    els.printDate.textContent = 'Prepared ' + new Date().toLocaleDateString(undefined, {
      year: 'numeric', month: 'long', day: 'numeric'
    });
  };

  const printSchedule = () => {
    if (activeView === 'classes') return;
    if (!classes.length) {
      showNotice(
        'Timetable is empty',
        "There's nothing to print yet.",
        'Add at least one class to your timetable before printing it.'
      );
      return;
    }

    /* Guarantee only the view the user is looking at is printed. */
    $('#view-timetable').hidden = activeView !== 'timetable';
    $('#view-classes').hidden = activeView !== 'classes';

    /* Re-render the list so the printout always matches the active day tab. */
    if (activeView === 'classes') {
      const activeDay = $('.chip.is-active', els.dayChips);
      if (activeDay && filters.day !== activeDay.dataset.day) {
        filters.day = activeDay.dataset.day;
      }
      renderClassList(getConflictIds());
    }

    updatePrintDetails();
    window.print();
  };

  /* Feature 9: pop-up class reminders with a flashing attention effect ------ */

  /** Local YYYY-MM-DD, zero-padded so keys sort chronologically as strings. */
  const dateKeyOf = (date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

  /** One reminder per class occurrence (class id + calendar date). */
  const occurrenceKeyOf = (item, date) => `${item.id}|${dateKeyOf(date)}`;

  const loadReminderMemory = () => {
    try {
      const raw = localStorage.getItem(REMINDER_STORE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      reminderMemory = parsed && typeof parsed === 'object' ? new Map(Object.entries(parsed)) : new Map();
    } catch (error) {
      reminderMemory = new Map();
    }
  };

  /** Drop dismissed / snoozed records from before yesterday. */
  const pruneReminderMemory = () => {
    const cutoff = dateKeyOf(new Date(Date.now() - 24 * 60 * 60 * 1000));
    [...reminderMemory.keys()].forEach((key) => {
      const datePart = key.split('|')[1];
      if (!datePart || datePart < cutoff) reminderMemory.delete(key);
    });
  };

  const saveReminderMemory = () => {
    try {
      localStorage.setItem(REMINDER_STORE_KEY, JSON.stringify(Object.fromEntries(reminderMemory)));
    } catch (error) {
      /* Reminders still work for this visit even if storage is blocked. */
    }
  };

  /** True once the user dismissed this occurrence, or is still snoozing it. */
  const isReminderBlocked = (key) => {
    const memory = reminderMemory.get(key);
    return Boolean(memory && (memory.dismissed || memory.snoozedUntil > Date.now()));
  };

  /** The soonest class starting within the reminder window that is not muted. */
  const findDueReminder = () => {
    const now = new Date();
    const dayIndex = now.getDay(); /* 0 = Sunday; CLASP weeks run Monday–Saturday */
    if (dayIndex === 0) return null;

    const minutesNow = now.getHours() * 60 + now.getMinutes();
    return (
      classes
        .filter((item) => item.day === DAYS[dayIndex - 1])
        .map((item) => ({
          key: occurrenceKeyOf(item, now),
          item,
          minutesLeft: toMinutes(item.start) - minutesNow
        }))
        .filter(
          (entry) =>
            entry.minutesLeft > 0 &&
            entry.minutesLeft <= REMINDER_LEAD_MINUTES &&
            !isReminderBlocked(entry.key)
        )
        .sort((a, b) => a.minutesLeft - b.minutesLeft)[0] || null
    );
  };

  const updateReminderCountdown = (minutesLeft) => {
    if (!els.reminderCountdown) return;
    const live = minutesLeft < 1;
    els.reminderCountdown.dataset.state = live ? 'live' : 'soon';
    els.reminderCountdown.textContent = live
      ? 'Happening now'
      : minutesLeft === 1
        ? 'Starts in 1 minute'
        : `Starts in ${minutesLeft} minutes`;
    /* Switches the card strobe from amber to red once the class is live. */
    els.reminderDialog.classList.toggle('is-live', live);
  };

  /** Flash the tab title too, so a backgrounded tab still grabs attention. */
  const flashDocumentTitle = (enabled) => {
    window.clearInterval(reminderTitleTimer);
    reminderTitleTimer = null;
    if (!enabled) {
      if (reminderBaseTitle !== null) document.title = reminderBaseTitle;
      reminderBaseTitle = null;
      return;
    }
    if (reminderBaseTitle === null) reminderBaseTitle = document.title;
    let flipped = false;
    reminderTitleTimer = window.setInterval(() => {
      flipped = !flipped;
      document.title = flipped ? REMINDER_TITLE_FLASH : reminderBaseTitle;
    }, 900);
  };

  const closeReminderDialog = (handled) => {
    reminderCloseHandled = handled;
    if (els.reminderDialog.open) {
      els.reminderDialog.close();
    } else {
      reminderCloseHandled = false;
    }
  };

  /** Keeps the countdown pill current while the pop-up is open. */
  const startReminderTicker = () => {
    window.clearInterval(reminderTicker);
    reminderTicker = window.setInterval(() => {
      if (!els.reminderDialog.open || !reminderActiveId) return;
      const item = classes.find((entry) => entry.id === reminderActiveId);
      if (!item) {
        /* The class vanished (e.g. deleted in another tab) — close quietly. */
        closeReminderDialog(false);
        return;
      }
      const now = new Date();
      updateReminderCountdown(toMinutes(item.start) - (now.getHours() * 60 + now.getMinutes()));
    }, 1000);
  };

  const showReminder = (entry) => {
    reminderActiveKey = entry.key;
    reminderActiveId = entry.item.id;

    els.reminderDetails.style.setProperty('--c', entry.item.color);
    els.reminderSubject.textContent = entry.item.subject;
    els.reminderWhen.textContent = `${entry.item.day} · ${formatRange(entry.item.start, entry.item.end)}`;
    els.reminderRoom.textContent = entry.item.room || 'Not set';
    els.reminderRoom.classList.toggle('is-empty', !entry.item.room);
    els.reminderInstructor.textContent = entry.item.instructor || 'Not set';
    els.reminderInstructor.classList.toggle('is-empty', !entry.item.instructor);
    updateReminderCountdown(entry.minutesLeft);

    els.reminderDialog.showModal();
    els.reminderDismissBtn.focus();
    startReminderTicker();
    flashDocumentTitle(true);
  };

  const checkReminders = () => {
    /* Never interrupt another dialog — the next check retries instead. */
    if (document.querySelector('dialog[open]')) return;

    const entry = findDueReminder();
    if (entry) showReminder(entry);
  };

  const dismissReminder = () => {
    if (reminderActiveKey) {
      reminderMemory.set(reminderActiveKey, { dismissed: true, snoozedUntil: 0 });
      saveReminderMemory();
    }
    closeReminderDialog(true);
  };

  const snoozeReminder = () => {
    if (reminderActiveKey) {
      reminderMemory.set(reminderActiveKey, {
        dismissed: false,
        snoozedUntil: Date.now() + REMINDER_SNOOZE_MINUTES * 60 * 1000
      });
      saveReminderMemory();
    }
    closeReminderDialog(true);
    showToast(`Snoozed — the reminder will pop up again in ${REMINDER_SNOOZE_MINUTES} minutes.`, 'success');
  };

  const startReminderLoop = () => {
    window.setInterval(checkReminders, REMINDER_CHECK_MS);
    /* Catch reminders that came due while the tab was in the background. */
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) checkReminders();
    });
  };

  /* Event listeners (10+ event-driven interactions) */
  const bindEvents = () => {
    /* Navigation */
    $('.main-nav').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-view]');
      if (button) setView(button.dataset.view);
    });

    /* Theme + print */
    els.themeToggle.addEventListener('click', toggleTheme);
    $('#printBtn').addEventListener('click', printSchedule);
    window.addEventListener('beforeprint', updatePrintDetails);

    /* One delegated handler for all action buttons */
    document.addEventListener('click', (event) => {
      const actionEl = event.target.closest('[data-action]');
      if (actionEl) {
        const action = actionEl.dataset.action;
        if (action === 'add') openClassForm(null);
        else if (action === 'edit') openClassForm(actionEl.dataset.id);
        else if (action === 'delete') requestDelete(actionEl.dataset.id);
        else if (action === 'load-sample') loadSample();
        else if (action === 'clear-filters') clearFilters();
        return;
      }

      event.target.closest('[data-close]')?.closest('dialog')?.close();
    });

    /* Close dialogs when the backdrop is clicked */
    [els.classDialog, els.confirmDialog, els.noticeDialog, els.reminderDialog].forEach((dialog) => {
      dialog.addEventListener('click', (event) => {
        if (event.target === dialog) dialog.close();
      });
    });

    /* Form events */
    els.classForm.addEventListener('submit', handleSubmit);

    els.classForm.addEventListener('input', (event) => {
      const { name } = event.target;
      if (name && name !== 'color') setFieldError(name, '');
      if (name === 'day' || name === 'start' || name === 'end') resetConflictState();
    });

    els.classForm.addEventListener('change', (event) => {
      if (event.target.name === 'day' || event.target.name === 'start' || event.target.name === 'end') {
        resetConflictState();
      }
    });

    els.deleteBtn.addEventListener('click', () => {
      const id = editingId;
      if (!id) return;
      closeClassForm();
      requestDelete(id);
    });

    els.classDialog.addEventListener('close', () => {
      editingId = null;
      conflictAcknowledged = false;
    });

    /* Delete confirmation */
    els.confirmDeleteBtn.addEventListener('click', () => {
      if (pendingDeleteId) {
        deleteClass(pendingDeleteId);
        pendingDeleteId = null;
      }
      els.confirmDialog.close();
    });

    els.confirmDialog.addEventListener('close', () => {
      pendingDeleteId = null;
    });

    /* Reminder pop-up */
    els.reminderDialog.addEventListener('close', () => {
      /* Esc, backdrop click, or the × button close without a decision —
         mark the occurrence as dismissed so it does not instantly re-pop. */
      if (reminderActiveKey && !reminderCloseHandled) {
        reminderMemory.set(reminderActiveKey, { dismissed: true, snoozedUntil: 0 });
        saveReminderMemory();
      }
      reminderCloseHandled = false;
      reminderActiveKey = null;
      reminderActiveId = null;
      els.reminderDialog.classList.remove('is-live');
      window.clearInterval(reminderTicker);
      reminderTicker = null;
      flashDocumentTitle(false);
    });

    els.reminderDismissBtn.addEventListener('click', dismissReminder);
    els.reminderSnoozeBtn.addEventListener('click', snoozeReminder);

    /* Search + day filter */
    els.searchInput.addEventListener('input', searchClasses);

    els.dayChips.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-day]');
      if (button) filterByDay(button.dataset.day);
    });

    /* Keep multiple tabs in sync */
    window.addEventListener('storage', (event) => {
      if (event.key === STORAGE_KEY) {
        loadData();
        renderAll();
        showToast('Schedule updated from another tab.', 'success');
      } else if (event.key === REMINDER_STORE_KEY) {
        loadReminderMemory();
      }
    });
  };

  /* Init */
  const init = () => {
    renderColorPicker();
    loadData();
    applyTheme(document.documentElement.dataset.theme);
    bindEvents();
    updateWeekLabel();
    renderAll();

    /* Feature 9: reminder pop-ups */
    loadReminderMemory();
    pruneReminderMemory();
    els.reminderSnoozeBtn.textContent = `Snooze ${REMINDER_SNOOZE_MINUTES} min`;
    els.reminderHint.textContent =
      `A reminder like this pops up ${REMINDER_LEAD_MINUTES} minutes before each class starts.`;
    startReminderLoop();
    checkReminders();
  };

  init();
})();
