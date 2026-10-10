'use strict';
(() => {
  const name='animesss-club-watchdog', key='animesssCardHelper.clubBoostEnabled';
  const checks=new Map([[name+'-02',2],[name+'-03',3],[name,5]]);
  async function sync() {
    const enabled=(await chrome.storage.local.get(key))[key]===true;
    const now=Date.now(), date=new Date(now+3*3600000);
    for(const [alarmName,minute] of checks){
      if(!enabled){await chrome.alarms.clear(alarmName);continue;}
      if(await chrome.alarms.get(alarmName))continue;
      let when=Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate(),18,minute);
      if(when<=now)when+=86400000;
      await chrome.alarms.create(alarmName,{when,periodInMinutes:1440});
    }
  }
  chrome.alarms.onAlarm.addListener(async alarm=>{
    if(!checks.has(alarm.name))return;
    try {
      if((await chrome.storage.local.get(key))[key]!==true)return;
      const tabs=await chrome.tabs.query({url:['https://animesss.com/clubs/boost/*','https://animesss.tv/clubs/boost/*']});
      // One tab only: never start two independent contribution loops.
      for(const tab of tabs){
        if(tab.discarded || new URL(tab.url).searchParams.get('id')!=='402')continue;
        try{const result=await chrome.tabs.sendMessage(tab.id,{type:'animesss-club-watchdog',minute:checks.get(alarm.name)});
          if(result?.accepted)break;
        }catch{/* Try the next already-open tab if this one has no content script. */}
      }
    }catch(error){console.error('Проверка авто-взноса 21:05:',error);}
  });
  chrome.storage.onChanged.addListener((changes,area)=>{
    if(area==='local' && changes[key])void sync().catch(console.error);
  });
  chrome.runtime.onStartup.addListener(()=>void sync().catch(console.error));
  chrome.runtime.onInstalled.addListener(()=>void sync().catch(console.error));
  void sync().catch(console.error);
})();
