export function installMock({ onboarding = false } = {}) {
  const user = { id: "u1", email: "tester@example.test", user_metadata: { display_name: "Tester" } };
  let session = null;
  let authCallback = () => {};
  const rows = {
    users: [{ id: "u1",email:user.email,name:"Tester",role:"owner",household_id:onboarding ? null : "h1" }],
    households: [{id:"h1",name:"Test Home"}],
    household_members: onboarding ? [] : [{id:"m1",household_id:"h1",user_id:"u1",role:"owner"}],
    household_invites: [],tasks:[],reminders:[],bills:[],routines:[],routine_items:[],routine_completions:[],
    events: [
      { id:"span",household_id:"h1",title:"Vacation",event_date:"2026-10-01",end_date:"2026-10-17",completed:false,status:"scheduled" },
      { id:"future",household_id:"h1",title:"Future appointment",event_date:"2026-10-12",start_time:"15:00:00",completed:false,status:"scheduled" },
      { id:"month",household_id:"h1",title:"Month event",event_date:"2026-10-28",completed:false,status:"scheduled" },
      { id:"done",household_id:"h1",title:"Completed hidden",event_date:"2026-10-04",completed:true,status:"completed" },
    ],
    weekly_plans:[{id:"w1",household_id:"h1",week_start_date:"2026-09-27",notes:"Old freeform notes"}],
    weekly_plan_items:[{id:"wi1",household_id:"h1",weekly_plan_id:"w1",title:"Scheduled chore",item_type:"chore",scheduled_date:"2026-10-03",scheduled_time:"10:00",completed:false}],
    notification_settings:[],notifications:[],user_notification_settings:[],push_subscriptions:[],
  };
  window.__rows=rows;
  window.__badgeCalls=[];
  window.__signupCalls=0;
  navigator.setAppBadge=async n=>window.__badgeCalls.push(n);
  navigator.clearAppBadge=async ()=>window.__badgeCalls.push(0);
  function from(table) {
    let mode="select", payload, one=false;
    const filters=[];
    const query={
      select(){return query;},order(){return query;},limit(){return query;},
      eq(k,v){filters.push(r=>r[k]===v);return query;},in(k,v){filters.push(r=>v.includes(r[k]));return query;},
      is(k,v){filters.push(r=>(r[k] ?? null)===v);return query;},lte(k,v){filters.push(r=>r[k]<=v);return query;},
      insert(v){mode="insert";payload=v;return query;},upsert(v){mode="upsert";payload=v;return query;},
      update(v){mode="update";payload=v;return query;},delete(){mode="delete";return query;},
      single(){one=true;return query;},maybeSingle(){one=true;return query;},
      then(resolve,reject){
        try {
          const list=rows[table] ||= [];
          let found=list.filter(r=>filters.every(f=>f(r)));
          if(mode==="insert" || mode==="upsert") {
            const values=Array.isArray(payload)?payload:[payload];
            found=values.map(v=>({...v,id:v.id || crypto.randomUUID(),completed:v.completed ?? false}));
            list.push(...found);
          } else if(mode==="update") {
            found.forEach(r=>Object.assign(r,payload));
            if(payload.completed) rows.notifications.filter(n=>found.some(r=>r.id===n.related_item_id)).forEach(n=>n.read_at=new Date().toISOString());
          } else if(mode==="delete") rows[table]=list.filter(r=>!found.includes(r));
          resolve({data:structuredClone(one?(found[0] || null):found),error:null,count:found.length});
        } catch(e){reject(e);}
      },
    };
    return query;
  }
  window.__mockClient={
    from,
    auth:{
      async getSession(){return {data:{session},error:null};},
      onAuthStateChange(fn){authCallback=fn;return {data:{subscription:{unsubscribe(){}}}};},
      async signInWithPassword(){session={user};authCallback("SIGNED_IN",session);return {data:{session},error:null};},
      async signUp(){window.__signupCalls++;return {data:{user},error:null};},
      async signOut(){session=null;authCallback("SIGNED_OUT",null);return {error:null};},
    },
    async rpc(name){
      if(name==="accept_household_invite") {rows.household_members.push({id:"joined",household_id:"h1",user_id:"u1",role:"member"});rows.users[0].household_id="h1";return {data:"h1",error:null};}
      return {data:null,error:null};
    },
  };
}
