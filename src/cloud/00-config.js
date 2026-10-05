/* =====================================================================
   SteelTrack Cloud — shared configuration
   ---------------------------------------------------------------------
   Which saved data belongs to which permission section, and which app
   pages belong to which section. If a new module is added to the app
   with a new localStorage key, add the key to KEY_SECTION below or it
   will stay on that one device only (it will NOT be shared).
   ===================================================================== */
(function(){
  "use strict";
  var ST = window.SteelTrackCloud = window.SteelTrackCloud || {};

  ST.SECTIONS = [
    { id:'projects',  label:'Projects',  desc:'Sales / CRM, Projects, Project Cost, Tasks, Company Map' },
    { id:'technical', label:'Technical', desc:'Drawing Register, Submittals, RFI, Erection drawings' },
    { id:'factory',   label:'Factory',   desc:'Fabrication, Materials, Material Planning, Scrap, Inventory, QA/QC, NCR, CNC, Delivery Notes, Equipment' },
    { id:'site',      label:'Site',      desc:'Site Erection, Transport, Daily Site Reports, HSE / Safety' },
    { id:'office',    label:'Office',    desc:'Purchase Orders, Supplier Payments, Client Invoicing, Attendance, Leave & HR, Performance' }
  ];
  ST.SECTION_IDS = ST.SECTIONS.map(function(s){ return s.id; });
  ST.LEVELS = ['none','view','edit'];

  // Saved data key -> section. 'common' = every approved user can add to it.
  ST.KEY_SECTION = {
    // Projects
    'steeltrack-sales-v1':'projects', 'steeltrack-projects-v1':'projects',
    'steeltrack-projectcost-v1':'projects', 'steeltrack-tasks-v1':'projects',
    'steeltrack-locations-v1':'projects', 'steeltrack-factory-location-v1':'projects',
    // Technical
    'steeltrack-drawings-v1':'technical', 'steeltrack-submittals-v1':'technical', 'steeltrack-rfi-v1':'technical',
    // Factory
    'steeltrack-baselist-v1':'factory',          // the master assembly list (used to be built into the page)
    'steeltrack-overlay-v2':'factory',           // fabrication progress, added/deleted items
    'steeltrack-priority-v1':'factory', 'steeltrack-newitems-v1':'factory',
    'steelstock-data-v1':'factory', 'steelstock-check-v1':'factory', 'fasteners-stock-v1':'factory',
    'partlists-v1':'factory', 'deliverynotes-v1':'factory',
    'steeltrack-matreq-v1':'factory', 'steeltrack-stockitems-v1':'factory', 'steeltrack-scrap-v1':'factory',
    'steeltrack-qaqc-v1':'factory', 'steeltrack-ncr-v1':'factory',
    'cncparts-v1':'factory', 'cncparts-cutlog-v1':'factory', 'steeltrack-equipment-v1':'factory',
    // Site
    'steeltrack-site-v1':'site', 'steeltrack-transport-v1':'site',
    'steeltrack-sitereports-v1':'site', 'steeltrack-hse-v1':'site',
    // Office
    'purchaseorders-v1':'office', 'steeltrack-payments-v1':'office', 'steeltrack-invoicing-v1':'office',
    'attendance-employees-v1':'office', 'attendance-punchlog-v1':'office',
    'steeltrack-leave-v1':'office', 'steeltrack-performance-v1':'office',
    // Everyone
    'steeltrack-activity-v1':'common'
  };

  // App page (sidebar tab) -> section. Pages not listed are visible to all.
  ST.TAB_SECTION = {
    sales:'projects', projects:'projects', projectcost:'projects', tasks:'projects', companymap:'projects',
    drawings:'technical', submittals:'technical', rfi:'technical',
    newitems:'factory', stock:'factory', matplan:'factory', scrap:'factory', inventory:'factory',
    fab:'factory', qaqc:'factory', ncr:'factory', cnc:'factory', equipment:'factory',
    site:'site', transport:'site', sitereports:'site', hse:'site',
    po:'office', payments:'office', invoicing:'office', attendance:'office', leave:'office', performance:'office'
  };
  ST.ADMIN_TABS = { users:true };
  ST.HIDDEN_TABS = { connsync:true };   // old same-Wi-Fi sync page, replaced by the cloud

  // Attachment stores (each module's own browser file store) -> section.
  ST.FILE_NS_SECTION = {
    steeltrack_newitems_db:'factory', steeltrack_ncr_db:'factory',
    steeltrack_submittals_db:'technical', steeltrack_rfi_db:'technical', steeltrack_drawings_db:'technical',
    steeltrack_payments_db:'office', steeltrack_invoicing_db:'office',
    steeltrack_hse_db:'site',
    erection:'technical'
  };
  // Browser store name inside each module's database (for retry/migration reads).
  ST.FILE_NS_STORE = { erection:'drawings' };
  ST.FILE_NS_DB = { erection:'steeltrack_drawings_db' };

  // Data blocks that older versions of the app had built into the page file,
  // and the saved key each one corresponds to (used by the migration tool).
  ST.LEGACY_SEEDS = {
    seedData:'steeltrack-baselist-v1', overlaySeed:'steeltrack-overlay-v2', stockDataSeed:'steelstock-data-v1',
    partListsSeed:'partlists-v1', deliveryNotesSeed:'deliverynotes-v1', poDataSeed:'purchaseorders-v1',
    cncPartsSeed:'cncparts-v1'
  };

  ST.BACKUP_DAYS_KEPT = 14;
  ST.MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB per file

  ST.sectionOfKey = function(key){
    if(Object.prototype.hasOwnProperty.call(ST.KEY_SECTION, key)) return ST.KEY_SECTION[key];
    return null; // not shared
  };
  ST.sectionLabel = function(id){
    if(id === 'common') return 'Shared';
    for(var i=0;i<ST.SECTIONS.length;i++) if(ST.SECTIONS[i].id === id) return ST.SECTIONS[i].label;
    return id;
  };
})();
