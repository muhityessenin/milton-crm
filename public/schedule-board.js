"use strict";

(function(root,factory){
  const api=factory();
  if(typeof module!=="undefined"&&module.exports)module.exports=api;
  else root.MiltonScheduleBoard=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  function timeKey(value,timeZone="Asia/Almaty"){
    return new Intl.DateTimeFormat("en-GB",{timeZone,hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(new Date(value));
  }
  function timeMinutes(value){const [hours,minutes]=String(value||"").split(":").map(Number);return Number.isFinite(hours)&&Number.isFinite(minutes)?hours*60+minutes:null;}
  function shiftDate(value,days){const date=new Date(`${value}T12:00:00Z`);date.setUTCDate(date.getUTCDate()+days);return date.toISOString().slice(0,10);}
  function columns(slots,timeZone="Asia/Almaty"){return [...new Set(slots.map((slot)=>timeKey(slot.startAt,timeZone)))].sort((a,b)=>timeMinutes(a)-timeMinutes(b));}
  function nearestFree(slots,target,timeZone="Asia/Almaty",limit=5){
    const targetMinutes=timeMinutes(target);if(targetMinutes===null)return[];
    return slots.filter((slot)=>slot.status==="FREE").map((slot)=>({...slot,time:timeKey(slot.startAt,timeZone),distance:Math.abs(timeMinutes(timeKey(slot.startAt,timeZone))-targetMinutes)})).sort((a,b)=>a.distance-b.distance||a.startAt.localeCompare(b.startAt)).slice(0,limit);
  }
  function preset(slot,date){return{closerId:slot.closerId,date,slotId:slot.id};}
  function preferredMatchScore(trial,slotTime){const text=String(trial.preferredTimeText||"").toLowerCase(),minutes=timeMinutes(slotTime);let score=0;const clocks=[...text.matchAll(/(\d{1,2}):?(\d{2})?/g)].map((m)=>Number(m[1])*60+Number(m[2]||0));if(/после/.test(text)&&clocks[0]!=null&&minutes>=clocks[0])score+=4;if(/вечер/.test(text)&&minutes>=1080)score+=3;if(clocks.length>=2&&minutes>=clocks[0]&&minutes<=clocks[1])score+=5;if(trial.preferredStartTime&&minutes>=timeMinutes(trial.preferredStartTime))score+=3;if(trial.preferredEndTime&&minutes<=timeMinutes(trial.preferredEndTime))score+=3;return score;}
  function rankUnassigned(items,slotTime){return[...items].sort((a,b)=>preferredMatchScore(b,slotTime)-preferredMatchScore(a,slotTime)||String(a.createdAt).localeCompare(String(b.createdAt)));}
  return{timeKey,timeMinutes,shiftDate,columns,nearestFree,preset,preferredMatchScore,rankUnassigned};
});
