/* Screenshot fixture only. Loads the unchanged application with fictional data.
   Never included in the production bundle. Served on a separate local port. */
(() => {
  const params = new URLSearchParams(location.search);
  const role = params.get('role') === 'editor' ? 'editor' : 'worker';
  // Capture the application's post-print confirmation without a physical job.
  window.print = () => setTimeout(() => window.dispatchEvent(new Event('afterprint')), 0);
  const at = '2026-10-08T01:00:00.000Z';
  const make = (id, customer, product, category, qty, due, statuses, extra = {}) => ({
    ...api.job(id, customer, product, due, qty, `見本-${id.slice(-3)}`, statuses, 'normal', at),
    category, specLength: '180mm', specShape: '直', bladeWidth: '2mm',
    distributionAssignee: '', productCode: `SAMPLE-${id.slice(-3)}`,
    labelPrintStatus: 'waiting', sourceRef: 'マニュアル撮影用の架空案件',
    productMaster: { key: id, productCode: `SAMPLE-${id.slice(-3)}`, materialLabel: '白銅', classCode: 'A', source: 'rule', message: '説明用データの区分' },
    polishing: { sentQuantity: 0, returnedQuantity: 0, history: [] }, ...extra,
  });
  const done = ['done', 'done', 'done', 'done', 'done'];
  const jobs = [
    make('SAMPLE-001', '見本医科', 'ケリソンパンチ 直 2mm', 'ケリソンパンチ', 10, '2026-10-15', ['done','done','working','not_started','not_started']),
    make('SAMPLE-002', 'サンプル商会', 'ケリソンパンチ 弱弯 3mm', 'ケリソンパンチ', 8, '2026-10-18', ['done','done','done','done','not_started'], {
      polishing: { sentQuantity: 8, returnedQuantity: 0, history: [{requestId:'manual-send-002',action:'send', quantity:8, at:'2026-10-06T01:00:00Z'}] },
    }),
    make('SAMPLE-003', '見本医科', '鋭匙鉗子 直 2mm', '鋭匙鉗子', 12, '2026-10-20', ['done','working','not_started','not_started','not_started'], {distributionAssignee:'豊'}),
    make('SAMPLE-004', 'サンプル商会', '鋭匙鉗子 弱弯 3mm', '鋭匙鉗子', 6, '2026-10-23', ['done','done','done','done','working'], {
      distributionAssignee:'幹', productMaster:{key:'SAMPLE-004',productCode:'SAMPLE-004',materialLabel:'白銅',classCode:'B',source:'rule',message:'説明用データの区分'},
      polishing:{sentQuantity:6,returnedQuantity:6,history:[{requestId:'manual-send-004',action:'send',quantity:6,at:'2026-10-01T01:00:00Z'},{requestId:'manual-return-004',action:'return',quantity:6,at:'2026-10-06T01:00:00Z'}]},
    }),
    make('SAMPLE-005', '見本医科', 'ケリソンパンチ 強弯 2mm', 'ケリソンパンチ', 5, '2026-10-12', done, {shippingStatus:'waiting'}),
    make('SAMPLE-006', 'サンプル商会', '鋭匙鉗子 強弯 2mm', '鋭匙鉗子', 4, '2026-10-05', done, {shippingStatus:'shipped',completedAt:at,distributionAssignee:'豊',labelPrintStatus:'printed'}),
  ];
  if (params.get('case') === 'billing') {
    const returned = (id, quantity) => ({sentQuantity:quantity,returnedQuantity:quantity,history:[
      {requestId:`manual-send-${id}`,action:'send',quantity,at:'2026-10-02T01:00:00Z'},
      {requestId:`manual-return-${id}`,action:'return',quantity,at:'2026-10-07T01:00:00Z'},
    ]});
    jobs.push(make('SAMPLE-007','見本医科','メニスカス鉗子 直 2mm','鋭匙鉗子',4,'2026-10-25',['done','done','done','done','not_started'],{
      productMaster:{key:'SAMPLE-007',productCode:'SAMPLE-007',materialLabel:'白銅',classCode:'B(メニスカス)',source:'rule',message:'品名ルール: メニスカス'},
      polishing:returned('007',4),
    }));
    jobs.push(make('SAMPLE-008','サンプル商会','ケリソンパンチ 直 4mm','ケリソンパンチ',2,'2026-10-26',['done','done','done','done','not_started'],{
      productMaster:{key:'SAMPLE-008',productCode:'SAMPLE-008',materialLabel:'白銅',classCode:'江部電解',source:'manual',message:'手動設定'},
      polishing:returned('008',2),
    }));
  }
  const intake = [{
    id:'SAMPLE-INTAKE-1', sourceType:'image', sourceRef:'見本注文書.pdf', subject:'見本注文書.pdf / 品目1', sender:'',
    receivedAt:at, status:'pending', confidence:0.92, parserVersion:2, version:1,
    parsed:{customer:'見本医科',product:'ケリソンパンチ 直 2mm',category:'ケリソンパンチ',quantity:10,dueDate:'2026-10-28',serialNo:'見本-101',specLength:'180mm',specShape:'直',bladeWidth:'2mm'},
  }];
  const data = {jobs,intake,localIntakeParserVersion:2,settings:{
    stageAssignees:JSON.stringify(Object.fromEntries(STAGES.map(s => [s.key,ASSIGNEES]))),
    distributionAssignees:JSON.stringify(['豊','幹','望','鈴']),
    polishingRates:'{}',
    polishingProductRules:params.get('case') === 'billing' ? JSON.stringify({'SAMPLE-008':{classCode:'江部電解'}}) : '{}',
  }};
  api.storageKey = 'production-board-manual-screenshots-v1';
  api.write(data);
  api.productMetadata = async value => {
    const rules = JSON.parse(value.settings?.polishingProductRules || '{}');
    return {jobs:value.jobs.map(job => {
      const code=rules[job.productMaster?.key]?.classCode;
      return code ? {...job,productMaster:{...job.productMaster,classCode:code,source:'manual',message:'手動設定'}} : job;
    }),productMasterStatus:{status:'snapshot',asOf:at,warning:''}};
  };
  api.getSnapshot = async () => ({
    ...api.read(), access:{email:`${role}@example.com`,role,isOwner:false,isAdmin:false,canEdit:role==='editor',canWork:true},
    accessSettings:null, aiImport:{ready:false,configured:false},scriptEditorUrl:'',
    productMasterStatus:{status:'snapshot',asOf:at,warning:''},mode:'demo',serverTime:at,setupRequired:false,
  });
  if (params.get('case') === 'error') api.saveJobProcess = async () => {throw new Error('通信に失敗しました。接続を確認して、保存し直してください。');};
  // The app's initial local snapshot was already started before this deferred
  // fixture ran. Reapply our role after it settles, then render the real UI.
  setTimeout(async () => {
    await refreshData();
    if (params.get('case') === 'bulk-held') {
      openProcessDialog(state.jobs.find(job => job.id === 'SAMPLE-001'), 'welding');
      const button = document.querySelector(".stage-edit-row[data-stage-key='welding'] [data-assignee='豊']");
      const rect = button.getBoundingClientRect();
      processGesture = {button,pointerId:1,startX:rect.x+rect.width/2,startY:rect.y+rect.height/2,armed:false,timer:null};
      armProcessGesture(processGesture);
    }
    document.documentElement.dataset.manualReady = role;
  }, 650);
})();
