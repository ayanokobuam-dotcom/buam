/* =========================================================================
   Active Recall — local data layer
   -------------------------------------------------------------------------
   This repo has no backend, so this file plays the role of the database
   described in the product spec: each "table" below is a JSON array kept
   in localStorage under its own key, with the exact same columns the spec
   lists. Swapping this for a real API later means replacing the bodies of
   Table.* below — every caller in app.js only talks to Table, never to
   localStorage directly, and record shapes (ids, FKs, timestamps) already
   match what a SQL schema would look like:

     subjects -> topics -> subtopics -> lessons -> lesson_sections
     recall_notes            (one per saved recall)
     active_recall_sessions  (one per read->recall attempt, for analytics)

   None of this wires into a real spaced-repetition scheduler yet (that is
   explicitly out of scope for this milestone) — srsSignalForRating() below
   only computes and stores a conservative signal alongside each session so
   a future SRS engine has something to read.
   ========================================================================= */

(function (global) {
  "use strict";

  var STORAGE_PREFIX = "activeRecall.";
  var SEED_VERSION_KEY = STORAGE_PREFIX + "seedVersion";
  var CURRENT_SEED_VERSION = 1;

  var LOCAL_USER_ID = "local-user";

  function nowIso() {
    return new Date().toISOString();
  }

  function uid(prefix) {
    return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function readTable(name) {
    try {
      var raw = global.localStorage.getItem(STORAGE_PREFIX + name);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function writeTable(name, rows) {
    try {
      global.localStorage.setItem(STORAGE_PREFIX + name, JSON.stringify(rows));
    } catch (e) {
      /* storage unavailable (private mode / quota) — app still works in-memory for the session */
    }
  }

  /* A tiny in-memory cache per table keeps repeated list() calls cheap
     during a single render pass, while writeTable() keeps localStorage as
     the source of truth across reloads. */
  var cache = {};

  function table(name) {
    if (!cache[name]) cache[name] = readTable(name);
    return cache[name];
  }

  function persist(name) {
    writeTable(name, cache[name] || []);
  }

  var Table = {
    list: function (name, predicate) {
      var rows = table(name);
      return predicate ? rows.filter(predicate) : rows.slice();
    },
    get: function (name, id) {
      var rows = table(name);
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].id === id) return rows[i];
      }
      return null;
    },
    insert: function (name, row) {
      var rows = table(name);
      rows.push(row);
      persist(name);
      return row;
    },
    update: function (name, id, patch) {
      var rows = table(name);
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].id === id) {
          Object.assign(rows[i], patch);
          persist(name);
          return rows[i];
        }
      }
      return null;
    }
  };

  /* ----------------------------------------------------------------- */
  /* Seed content — Biology / Chemistry / Physics, matching the spec's  */
  /* worked example (Biology -> Cell Biology -> Cell Organelles ->      */
  /* Mitochondria) plus enough breadth for the analytics examples.      */
  /* Seeding only touches content tables, never user-generated ones.    */
  /* ----------------------------------------------------------------- */

  function seedIfNeeded() {
    var seededVersion = 0;
    try {
      seededVersion = parseInt(global.localStorage.getItem(SEED_VERSION_KEY) || "0", 10);
    } catch (e) {}
    if (seededVersion >= CURRENT_SEED_VERSION) return;

    var subjects = [
      { id: "subj_biology", name: "Biology", created_at: nowIso() },
      { id: "subj_chemistry", name: "Chemistry", created_at: nowIso() },
      { id: "subj_physics", name: "Physics", created_at: nowIso() }
    ];

    var topics = [
      { id: "topic_cell_biology", subject_id: "subj_biology", name: "Cell Biology", created_at: nowIso() },
      { id: "topic_genetics", subject_id: "subj_biology", name: "Genetics", created_at: nowIso() },
      { id: "topic_organic_chem", subject_id: "subj_chemistry", name: "Organic Chemistry", created_at: nowIso() },
      { id: "topic_mechanics", subject_id: "subj_physics", name: "Mechanics", created_at: nowIso() }
    ];

    var subtopics = [
      { id: "subtopic_cell_organelles", topic_id: "topic_cell_biology", name: "Cell Organelles", created_at: nowIso() }
    ];

    var lessons = [
      {
        id: "lesson_cell_organelles",
        topic_id: "topic_cell_biology",
        subtopic_id: "subtopic_cell_organelles",
        title: "Cell Organelles",
        description: "The main organelles found in a eukaryotic cell and what each one does.",
        estimated_minutes: 12,
        created_at: nowIso(),
        updated_at: nowIso()
      },
      {
        id: "lesson_mendelian_genetics",
        topic_id: "topic_genetics",
        subtopic_id: null,
        title: "Mendelian Inheritance",
        description: "Dominant and recessive alleles, and how traits pass from parents to offspring.",
        estimated_minutes: 10,
        created_at: nowIso(),
        updated_at: nowIso()
      },
      {
        id: "lesson_functional_groups",
        topic_id: "topic_organic_chem",
        subtopic_id: null,
        title: "Functional Groups",
        description: "The reactive groups that define how organic molecules behave.",
        estimated_minutes: 14,
        created_at: nowIso(),
        updated_at: nowIso()
      },
      {
        id: "lesson_newtons_laws",
        topic_id: "topic_mechanics",
        subtopic_id: null,
        title: "Newton's Laws of Motion",
        description: "The three laws that describe how forces change motion.",
        estimated_minutes: 11,
        created_at: nowIso(),
        updated_at: nowIso()
      }
    ];

    var lessonSections = [
      {
        id: "section_intro",
        lesson_id: "lesson_cell_organelles",
        section_order: 1,
        title: "Introduction",
        content:
          "Every eukaryotic cell is divided into specialised compartments called organelles. " +
          "Each organelle carries out a specific job, the way a room in a house is built for a " +
          "specific purpose. Over the next few sections you will meet the mitochondria, the " +
          "ribosome, and the endoplasmic reticulum, and learn what each one is responsible for.",
        created_at: nowIso()
      },
      {
        id: "section_mitochondria",
        lesson_id: "lesson_cell_organelles",
        section_order: 2,
        title: "Mitochondria",
        content:
          "The mitochondrion is a membrane-bound organelle found in almost all eukaryotic cells. " +
          "It has two membranes: a smooth outer membrane and a highly folded inner membrane, whose " +
          "folds are called cristae. Mitochondria are responsible for producing most of the cell's " +
          "ATP through a process called oxidative phosphorylation, which relies on an electron " +
          "transport chain embedded in the inner membrane and a proton gradient built up across it. " +
          "Because of this central role in energy production, mitochondria are often called the " +
          "'powerhouse of the cell.'",
        created_at: nowIso()
      },
      {
        id: "section_ribosome",
        lesson_id: "lesson_cell_organelles",
        section_order: 3,
        title: "Ribosome",
        content:
          "Ribosomes are the sites of protein synthesis. They read the sequence of a messenger RNA " +
          "molecule and assemble amino acids into a growing polypeptide chain in the order the mRNA " +
          "specifies. Ribosomes can float free in the cytoplasm, producing proteins used inside the " +
          "cell, or attach to the endoplasmic reticulum to produce proteins destined for secretion " +
          "or for the cell membrane.",
        created_at: nowIso()
      },
      {
        id: "section_er",
        lesson_id: "lesson_cell_organelles",
        section_order: 4,
        title: "Endoplasmic Reticulum",
        content:
          "The endoplasmic reticulum (ER) is a network of membranes that folds and modifies proteins " +
          "and lipids. The rough ER is studded with ribosomes and specialises in processing proteins " +
          "that will be secreted or embedded in membranes. The smooth ER lacks ribosomes and instead " +
          "specialises in lipid synthesis and detoxification.",
        created_at: nowIso()
      },
      {
        id: "section_genetics_intro",
        lesson_id: "lesson_mendelian_genetics",
        section_order: 1,
        title: "Alleles and Dominance",
        content:
          "Each gene can exist in different versions called alleles. When an organism carries two " +
          "different alleles for a gene, the dominant allele determines the observable trait, while " +
          "the recessive allele's effect is masked. A recessive trait only appears when an organism " +
          "carries two copies of the recessive allele.",
        created_at: nowIso()
      },
      {
        id: "section_punnett",
        lesson_id: "lesson_mendelian_genetics",
        section_order: 2,
        title: "Punnett Squares",
        content:
          "A Punnett square is a diagram used to predict the possible genotypes of offspring from a " +
          "cross between two parents with known genotypes. Each parent's alleles are placed along " +
          "one edge of a grid, and each cell of the grid shows one possible combination the offspring " +
          "could inherit.",
        created_at: nowIso()
      },
      {
        id: "section_functional_groups_1",
        lesson_id: "lesson_functional_groups",
        section_order: 1,
        title: "Hydroxyl and Carbonyl Groups",
        content:
          "A hydroxyl group (-OH) makes a molecule more polar and able to form hydrogen bonds, as " +
          "seen in alcohols. A carbonyl group (C=O) appears in aldehydes and ketones, and its polarity " +
          "makes it a common site for chemical reactions.",
        created_at: nowIso()
      },
      {
        id: "section_newton_1",
        lesson_id: "lesson_newtons_laws",
        section_order: 1,
        title: "The First Law",
        content:
          "An object at rest stays at rest, and an object in motion stays in motion at a constant " +
          "velocity, unless acted on by a net external force. This tendency to resist a change in " +
          "motion is called inertia.",
        created_at: nowIso()
      },
      {
        id: "section_newton_2",
        lesson_id: "lesson_newtons_laws",
        section_order: 2,
        title: "The Second Law",
        content:
          "The acceleration of an object is directly proportional to the net force acting on it and " +
          "inversely proportional to its mass, summarised as F = ma. A larger force produces a larger " +
          "acceleration; a larger mass produces a smaller acceleration for the same force.",
        created_at: nowIso()
      }
    ];

    cache.subjects = subjects;
    cache.topics = topics;
    cache.subtopics = subtopics;
    cache.lessons = lessons;
    cache.lesson_sections = lessonSections;
    persist("subjects");
    persist("topics");
    persist("subtopics");
    persist("lessons");
    persist("lesson_sections");

    /* user-generated tables start empty but must exist */
    if (!cache.recall_notes) cache.recall_notes = readTable("recall_notes");
    if (!cache.active_recall_sessions) cache.active_recall_sessions = readTable("active_recall_sessions");

    try {
      global.localStorage.setItem(SEED_VERSION_KEY, String(CURRENT_SEED_VERSION));
    } catch (e) {}
  }

  /* ----------------------------------------------------------------- */
  /* Query helpers used across screens                                  */
  /* ----------------------------------------------------------------- */

  function getLessonSections(lessonId) {
    return Table.list("lesson_sections", function (s) {
      return s.lesson_id === lessonId;
    }).sort(function (a, b) {
      return a.section_order - b.section_order;
    });
  }

  function getLessonsForTopic(topicId) {
    return Table.list("lessons", function (l) {
      return l.topic_id === topicId;
    });
  }

  function getTopicsForSubject(subjectId) {
    return Table.list("topics", function (t) {
      return t.subject_id === subjectId;
    });
  }

  function getLessonContext(lessonId) {
    var lesson = Table.get("lessons", lessonId);
    if (!lesson) return null;
    var topic = Table.get("topics", lesson.topic_id);
    var subject = topic ? Table.get("subjects", topic.subject_id) : null;
    return { lesson: lesson, topic: topic, subject: subject };
  }

  /* Poor=1, Okay=2, Good=3, Excellent=4 — a conservative learning signal,
     never treated as objective mastery. Only computed + stored; nothing
     in this milestone schedules a review off of it. */
  function srsSignalForRating(rating) {
    switch (rating) {
      case 4:
        return { label: "strong", note: "Excellent recall — strong signal." };
      case 3:
        return { label: "normal", note: "Good recall — normal signal." };
      case 2:
        return { label: "weak", note: "Okay recall — weak signal." };
      case 1:
        return { label: "early-review", note: "Poor recall — recommend earlier review." };
      default:
        return null;
    }
  }

  function wordCount(text) {
    var trimmed = (text || "").trim();
    if (!trimmed) return 0;
    return trimmed.split(/\s+/).length;
  }

  /* Creates the recall_note row + marks the matching session complete in
     one step, since in this UI a save always happens at the end of one
     recall attempt. */
  function saveRecall(params) {
    var note = {
      id: uid("note"),
      user_id: LOCAL_USER_ID,
      lesson_id: params.lessonId,
      topic_id: params.topicId,
      section_id: params.sectionId,
      content: params.content,
      word_count: wordCount(params.content),
      self_rating: null,
      created_at: nowIso(),
      updated_at: nowIso()
    };
    Table.insert("recall_notes", note);

    if (params.sessionId) {
      Table.update("active_recall_sessions", params.sessionId, {
        completed_at: nowIso()
      });
    }
    return note;
  }

  function rateRecall(noteId, sessionId, rating) {
    var note = Table.update("recall_notes", noteId, {
      self_rating: rating,
      updated_at: nowIso()
    });
    if (sessionId) {
      Table.update("active_recall_sessions", sessionId, { self_rating: rating });
    }
    return note;
  }

  function startSession(lessonId, sectionId) {
    var session = {
      id: uid("session"),
      user_id: LOCAL_USER_ID,
      lesson_id: lessonId,
      section_id: sectionId,
      started_at: nowIso(),
      recall_started_at: nowIso(),
      completed_at: null,
      self_rating: null
    };
    Table.insert("active_recall_sessions", session);
    return session;
  }

  /* Reading progress per lesson (which sections have been finished) is not
     part of the spec's schema, but the "Continue Learning" home card and
     "Section X of N" flow both need it, so it is tracked the same way as
     everything else: a small localStorage-backed table. */
  function getReadSections(lessonId) {
    var row = Table.get("lesson_progress", lessonId);
    return row ? row.read_section_ids.slice() : [];
  }

  function markSectionRead(lessonId, sectionId) {
    var row = Table.get("lesson_progress", lessonId);
    if (row) {
      if (row.read_section_ids.indexOf(sectionId) === -1) {
        row.read_section_ids.push(sectionId);
        persist("lesson_progress");
      }
    } else {
      Table.insert("lesson_progress", { id: lessonId, read_section_ids: [sectionId] });
    }
  }

  /* ----------------------------------------------------------------- */
  /* Analytics — kept deliberately light: averages, not dashboards.     */
  /* ----------------------------------------------------------------- */

  function averageRatingBySubject() {
    var subjects = Table.list("subjects");
    var notes = Table.list("recall_notes", function (n) {
      return typeof n.self_rating === "number";
    });
    return subjects
      .map(function (subject) {
        var subjectNotes = notes.filter(function (n) {
          return n.topic_id && Table.get("topics", n.topic_id) && Table.get("topics", n.topic_id).subject_id === subject.id;
        });
        if (!subjectNotes.length) return { subject: subject, average: null, count: 0 };
        var sum = subjectNotes.reduce(function (acc, n) {
          return acc + n.self_rating;
        }, 0);
        return { subject: subject, average: sum / subjectNotes.length, count: subjectNotes.length };
      })
      .filter(function (row) {
        return row.count > 0;
      });
  }

  function weakTopics(limit) {
    var topics = Table.list("topics");
    var notes = Table.list("recall_notes", function (n) {
      return typeof n.self_rating === "number";
    });
    var rows = topics
      .map(function (topic) {
        var topicNotes = notes.filter(function (n) {
          return n.topic_id === topic.id;
        });
        if (!topicNotes.length) return null;
        var sum = topicNotes.reduce(function (acc, n) {
          return acc + n.self_rating;
        }, 0);
        return { topic: topic, average: sum / topicNotes.length };
      })
      .filter(Boolean)
      .filter(function (row) {
        return row.average < 3;
      })
      .sort(function (a, b) {
        return a.average - b.average;
      });
    return rows.slice(0, limit || 3);
  }

  /* "Due for review" heuristic (not a real SRS scheduler): a Poor/Okay
     recall not revisited in a day, or anything untouched for 3+ days. */
  function notesDueForReview() {
    var now = Date.now();
    var DAY = 24 * 60 * 60 * 1000;
    return Table.list("recall_notes", function (n) {
      if (typeof n.self_rating !== "number") return false;
      var age = now - new Date(n.updated_at).getTime();
      if (n.self_rating <= 2 && age > DAY) return true;
      if (age > 3 * DAY) return true;
      return false;
    });
  }

  function daysAgo(isoString) {
    var diff = Date.now() - new Date(isoString).getTime();
    var days = Math.floor(diff / (24 * 60 * 60 * 1000));
    if (days <= 0) return "today";
    if (days === 1) return "1 day ago";
    return days + " days ago";
  }

  global.RecallData = {
    LOCAL_USER_ID: LOCAL_USER_ID,
    seedIfNeeded: seedIfNeeded,
    Table: Table,
    getLessonSections: getLessonSections,
    getLessonsForTopic: getLessonsForTopic,
    getTopicsForSubject: getTopicsForSubject,
    getLessonContext: getLessonContext,
    srsSignalForRating: srsSignalForRating,
    wordCount: wordCount,
    saveRecall: saveRecall,
    rateRecall: rateRecall,
    startSession: startSession,
    getReadSections: getReadSections,
    markSectionRead: markSectionRead,
    averageRatingBySubject: averageRatingBySubject,
    weakTopics: weakTopics,
    notesDueForReview: notesDueForReview,
    daysAgo: daysAgo,
    uid: uid
  };
})(window);
