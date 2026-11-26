/* SafetyRoad 2.0 | Interfaz basada en wireframe aportado.
   Datos y reglas de negocio obtenidos del servidor Python, NO definidos en JS.
   Todos los incidentes y vídeos de este paquete son simulados. */
'use strict';

let store = {events: [], metrics: [], counts: {P1:0,P2:0,P3:0}, total:0};
let selected = '';
let showExamples = false; // Ocultos por defecto; solo visibles al habilitar demostración.
let filter = 'Todas';
let caseView = 'Activos'; // Activos, Cerrados y Archivados: nunca elimina estadísticas.
let panelMode = '';
let selectedServices = [];
let modalType = '';
let requesting = false;
const acking = new Set();
const $ = id => document.getElementById(id);
const labels = {P1:'P1 · Grave',P2:'P2 · Moderada',P3:'P3 · Leve',IND:'Indeterminado'};
const icons = {P1:'▲',P2:'◆',P3:'●',IND:'?'};
const states = {ALERTA_OPERADOR:'Pendiente de revisión',EN_REVISION:'En revisión',DERIVADO_SIMULADO:'Derivación registrada',CERRADO_ATENDIDO:'Cerrado como atendido',CERRADO_FALSA_ALARMA:'Descartado (falsa alarma)'};
const escapeHTML = str => String(str === undefined || str === null ? '' : str).replace(/[&<>"']/g, ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const caseById = id => store.events.find(e => e.id === id);
const current = () => caseById(selected);
const closed = e => String(e.st).startsWith('CERRADO');
const isVisible = e => caseView === 'Archivados' ? Boolean(e.archivado) : caseView === 'Cerrados' ? closed(e) && !e.archivado : !closed(e) && !e.archivado;
const visibleCases = () => store.events.filter(isVisible);
function ensureSelection(){if(!visibleCases().some(e=>e.id===selected))selected=visibleCases()[0]?.id||'';}
const formTime = stamp => {try{return new Date(stamp).toLocaleString('es-CL');}catch(_){return stamp;}};
const secondsAgo = stamp => {const diff=Math.max(0,Math.round((Date.now()-new Date(stamp).getTime())/1000));return diff<60?`hace ${diff} s`:diff<3600?`hace ${Math.floor(diff/60)} min`:`hace ${Math.floor(diff/3600)} h`;};
let toastTimer;
function toast(message) {
  const target=$('toast');target.textContent=message;target.classList.add('on');
  clearTimeout(toastTimer);toastTimer=setTimeout(()=>target.classList.remove('on'),3400);
}
async function api(path, payload) {
  const opts=payload===undefined?{cache:'no-store'}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)};
  let r=await fetch(path,opts);
  let data=await r.json();
  if(!r.ok) throw new Error(data.error || 'Error de conexión con el servicio');
  return data;
}

function drawHeader() {
  $('c1').textContent='P1: '+(store.counts.P1||0);
  $('c2').textContent='P2: '+(store.counts.P2||0);
  $('c3').textContent='P3: '+(store.counts.P3||0);
  const h=store.historico||{};
  $('totalCases').textContent=`Histórico: ${h.alertas_recibidas??0} alertas recibidas · ${h.incidentes_unicos??0} incidentes únicos · ${h.activos??0} activos · ${h.atendidos??0} atendidos · ${h.descartados??0} descartados`;
  $('toggleExamples').textContent=showExamples?'Ocultar ejemplos':'Mostrar ejemplos';
  $('toggleExamples').setAttribute('aria-pressed',String(showExamples));
  $('connection').textContent=store.camera_status||'Sin cámaras reales';
}
function drawFeed() {
  $('flt').innerHTML=['Todas','P1','P2','P3','IND'].map(f=>`<button class="chip ${f===filter?'on':''}" data-filter="${f}">${f==='IND'?'Indeterm.':f}</button>`).join('');
  const counts={Activos:store.events.filter(e=>!closed(e)&&!e.archivado).length,Cerrados:store.events.filter(e=>closed(e)&&!e.archivado).length,Archivados:store.events.filter(e=>e.archivado).length};
  $('caseViews').innerHTML=['Activos','Cerrados','Archivados'].map(v=>`<button type="button" class="case-tab ${caseView===v?'active':''}" data-view="${v}">${v} <span>${counts[v]}</span></button>`).join('');
  const evs=visibleCases().filter(e=>filter==='Todas'||e.p===filter);
  $('feed').innerHTML=evs.length?evs.map(e=>{
    const src=e.source==='CAMARA + APP'?'CÁMARA + APP':e.source==='APP'?'APP':e.source==='ARCHIVO VIDEO'?'VIDEO CARGADO':'CÁMARA · CARGA MANUAL';
    const urgente=e.requiere_asistencia ?'<span class="tag warn">SOLICITA AYUDA · SIN VERIFICAR</span>':'';
    const child=e.ninos==='indicios_por_verificar' ?'<span class="tag warn">Posibles niños: declaración sin verificar</span>':'';
    return `<button class="card ${e.p} ${e.id===selected?'sel':''} ${closed(e)?'done':''} ${e.st==='ALERTA_OPERADOR'?'open':''}" data-id="${escapeHTML(e.id)}">
       <div class="a"><span>${icons[e.p]} ${labels[e.p]}</span><span>${secondsAgo(e.created_at)}</span></div>
       <div class="ti">${escapeHTML(e.tipo)}</div>
       <div class="su">${escapeHTML(e.ubicacion)} · ${escapeHTML(e.camara||'Sin cámara')}</div>
       <div class="tags"><span class="tag">${src}</span>${urgente}${child}<span class="tag">${escapeHTML(states[e.st]||e.st)}</span></div>
    </button>`;
  }).join(''):'<p class="nd" style="padding:12px">No hay incidentes para este filtro.</p>';
}
const MAPBG=`<svg viewBox="0 0 100 100" preserveAspectRatio="none" style="position:absolute;inset:0;width:100%;height:100%"><polygon class="sea" points="0,0 17,0 19,45 17,100 0,100"/><path class="rd" d="M22,0 L24,45 L22,100"/><path class="rd" d="M63,0 L63,100"/><path class="rd m" d="M23,34 L100,34"/><path class="rd m" d="M23,62 L100,62"/><path class="rd m" d="M22,22 L100,22"/><path class="rd m" d="M22,86 L100,86"/></svg>
<span class="ml" style="left:2%;top:50%">Océano Pacífico</span>
<span class="ml" style="left:40%;top:6%;font-weight:700">LA SERENA</span>
<span class="ml" style="left:40%;top:90%;font-weight:700">COQUIMBO</span>
<span class="ml" style="left:24.5%;top:3%">Av. Costanera</span>
<span class="ml" style="left:64%;top:3%">Ruta 5</span>
<span class="ml" style="left:75%;top:24%">Av. Cuatro Esquinas</span>
<span class="ml" style="left:75%;top:36%">Av. F. de Aguirre</span>
<span class="ml" style="left:75%;top:64%">Av. Videla</span>
<div class="leg"><span><i style="background:var(--p1)"></i>P1 Grave</span><span><i style="background:var(--amb)"></i>P2 Moderada</span><span><i style="background:var(--g6)"></i>P3 Leve</span><span><i class="ind"></i>Indeterminado</span></div>`;
function drawMap() {
  let html=MAPBG+`<span class="lb">Mapa de referencia</span>`;
  for(const e of store.events.filter(e=>!closed(e) && !e.archivado)){
    const x=Number.isFinite(+e.x)? Math.min(92,Math.max(18,+e.x)):48;
    const y=Number.isFinite(+e.y)? Math.min(90,Math.max(12,+e.y)):48;
    html+=`<button class="mk ${e.p} ${e.id===selected?'sel':''}" style="left:${x}%;top:${y}%" data-id="${escapeHTML(e.id)}" title="${escapeHTML(e.tipo)}" aria-label="Ver ${escapeHTML(e.id)}"><b>${e.p==='IND'?'?':e.p}</b>${e.id===selected?`<em>${escapeHTML(e.tipo)}</em>`:''}</button>`;
  }
  $('map').innerHTML=html;
}
function drawVideo() {
  const e=current();
  if(!e){$('vid').innerHTML='<div class="video-placeholder">Selecciona una alerta.</div>';return;}
  $('vh').textContent=`Evidencia · ${e.id} · ${e.camara||'fuente APP'}`;
  if(e.evidencia_tipo==='video_sintetico') {
    $('frames').innerHTML=['antes','evento','despues'].map(x=>`<div><img src="/media/frame_${x}.jpg" alt="Fotograma ilustrativo"><em>${x}</em></div>`).join('');
    $('vid').innerHTML=`<video src="/media/demo_accidente.mp4" poster="/media/frame_antes.jpg" controls muted playsinline preload="metadata" aria-label="Video ilustrativo de referencia"></video>
     <span class="priv">VIDEO DE EJEMPLO · REVISIÓN VISUAL</span>`;
  } else if(e.evidencia_tipo==='video_usuario') {
    const fotos=(e.fotogramas||[]).map((ruta,i)=>`<div><img src="/${escapeHTML(ruta)}" alt="Fotograma ${i+1}"><em>${['antes','movimiento','después'][i]||'captura'}</em></div>`).join('');
    $('frames').innerHTML=fotos||'<div>Fotogramas no disponibles</div>';
    const ruta='/' + encodeURI(e.evidencia);
    $('vid').innerHTML=`<video src="${ruta}" controls muted playsinline preload="metadata"></video><span class="priv">VIDEO APORTADO · PENDIENTE DE REVISIÓN</span>`;
  } else {
    $('frames').innerHTML='<div>Sin video</div><div>Sin video</div><div>Sin video</div>';
    $('vid').innerHTML='<div class="video-placeholder"><div><b>Sin archivo de evidencia</b><p>Integración de cámaras pendiente. Se muestra solo la ficha del caso.</p></div></div>';
  }
  if(e.evidencia_tipo==='video_usuario') {
    const a=e.analisis||{};
    if(!a.disponible){$('det').textContent='Análisis automático no disponible. Requiere verificación visual.';}
    else {
      $('det').textContent='Cambio visual: '+a.pico+'% en '+a.momento+' s · '+(a.picos?.length||0)+' momentos destacados'+(a.aviso_camara_movil?' · posible movimiento de cámara':'')+' · sujeto a revisión';
    }
  } else {
    $('det').textContent='Vehículos declarados: '+(e.vehiculos||'No determinados')+' · información declarada';
  }
}
function drawDetails() {
  const e=current();
  if(!e){$('fic').innerHTML='Selecciona un caso.';return;}
  const reports=(e.reportes_app||[]).map(r=>`<li><b>${escapeHTML(r.descripcion)}</b><br><span class="muted">${escapeHTML(r.ubicacion)} · Sin verificar · ${escapeHTML(formTime(r.creado))}</span></li>`).join('');
  const tags=`<span class="pr ${e.p}">${icons[e.p]} ${labels[e.p]}${e.source==='APP'?' · PROPUESTA':''}</span><span class="pill">${escapeHTML(states[e.st]||e.st)}</span>`;
  $('fic').innerHTML=`<div class="ba">${tags}<h2>${escapeHTML(e.tipo).toUpperCase()}</h2>
   <div class="muted">${escapeHTML(e.razon)}</div><span class="case-tag">${escapeHTML(e.source)} · REGISTRO</span></div>
   <div class="grid">
    <div><label>Identificador</label>${escapeHTML(e.id)}</div>
    <div><label>Fecha / hora</label>${escapeHTML(formTime(e.created_at))}</div>
    <div><label>Cámara</label>${escapeHTML(e.camara||'No vinculada')}</div>
    <div><label>Vehículos registrados</label>${e.vehiculos||'<span class="nd">No determinado</span>'}</div>
    <div class="w"><label>Ubicación</label>${escapeHTML(e.ubicacion)}</div>
    ${e.requiere_asistencia?'<div class="w"><strong class="no-signal">⚠ La persona solicitó ayuda desde la app. Verificar prioridad cuanto antes: la gravedad sigue desconocida.</strong></div>':''}
    <div class="w"><label>Evaluación registrada por el operador</label>${e.evaluacion_operador?`<b>${escapeHTML(e.evaluacion_operador.prioridad)}</b> · ${escapeHTML(e.evaluacion_operador.tipo)}<br>${escapeHTML(e.evaluacion_operador.fundamento)}<br><small>Base: ${escapeHTML(e.evaluacion_operador.fuente)} · NO valida el rendimiento de un detector</small>`:'<span class="nd">Pendiente. No implica que el aviso de ayuda deba esperar.</span>'}</div>
    <div class="w"><label>Reporte desde</label>${escapeHTML(e.source)}${e.source==='APP'?' · Reporte ciudadano o sensor no verificado':''}</div>
    <div class="w"><label>Relación del reportante</label>${escapeHTML(e.rol_reportante==='testigo'?'Testigo':e.rol_reportante==='involucrado'?'Persona involucrada':e.rol_reportante==='tercero'?'Información de terceros':'No determinada')}</div>
    <div class="w"><label>Posible presencia de niños</label>${e.ninos==='confirmada'?'<span class="warn">Marcado manualmente (sin comprobación automática)</span>':e.ninos==='indicios_por_verificar'?'<span class="warn">Reportados por ciudadano, sin verificar</span>':e.ninos==='sin_indicios'?'No observados por reportante':'<span class="nd">No determinado</span>'}</div>
    <div class="w"><label>Señales / descripción registrada</label><ul>${(e.senales||[]).map(s=>`<li>${escapeHTML(s)}</li>`).join('')||'<li>Sin antecedentes</li>'}</ul></div>
    <div class="w"><label>Evidencia</label>${e.evidencia?'<span>'+escapeHTML(e.evidencia_tipo==='video_usuario'?'Video aportado por usuario, no verificado':e.evidencia_tipo==='video_sintetico'?'Video de referencia':'Evidencia disponible')+'</span>':'<span class="nd">No adjunta</span>'}</div>
    <div class="w"><label>Reportes de app asociados (${(e.reportes_app||[]).length})</label>${reports?'<ul>'+reports+'</ul>':'<span class="nd">Sin reportes vinculados</span>'}</div>
    <div class="w"><label>Posibles coincidencias</label>${(e.coincidencias||[]).length?`<ul>${e.coincidencias.map(c=>`<li><b>${escapeHTML(c.id)}</b>: ${escapeHTML(c.motivo)} (NO confirmado)</li>`).join('')}</ul>`:'<span class="nd">Sin coincidencias sugeridas</span>'}</div>
    <div class="w"><label>Servicios derivados</label>${e.servicios?.length?escapeHTML(e.servicios.join(', '))+' (registro interno)':'<span class="nd">Ninguno</span>'}</div>
    ${e.resumen_derivacion_demo?`<div class="w"><label>Resumen de derivación</label><div class="no-signal">Registro administrativo interno; no se realizó despacho externo.</div><b>${escapeHTML(e.resumen_derivacion_demo.id)}</b> · ${escapeHTML(e.resumen_derivacion_demo.tipo)} · ${escapeHTML(e.resumen_derivacion_demo.prioridad)}<br>${escapeHTML(e.resumen_derivacion_demo.ubicacion)}<br>Para: ${escapeHTML((e.resumen_derivacion_demo.destinatarios||[]).join(', '))}<br><small>${escapeHTML(e.resumen_derivacion_demo.prioridad_estado)}</small></div>`:''}
    <div class="w"><label>Movimientos registrados</label>${e.historial?.length?`<ul>${e.historial.map(h=>`<li>${escapeHTML(h.accion)} · ${escapeHTML(formTime(h.fecha))}</li>`).join('')}</ul>`:'<span class="nd">Sin acciones todavía</span>'}</div>
   </div>`;
}
function drawActions() {
  const e=current();if(!e){$('ctrl').innerHTML='';return;}
  let html=`<div>Estado: <span class="pill" style="margin:0">${escapeHTML(states[e.st]||e.st)}</span></div>`;
  if(e.source==='APP' && (e.coincidencias||[]).length && !closed(e)){
    html+='<div class="no-signal">Coincidencia sugerida; requiere confirmación del operador.</div>';
    html+=(e.coincidencias||[]).map(c=>`<button class="btn" data-linkcam="${escapeHTML(c.id)}">VINCULAR CON ${escapeHTML(c.id)} (confirmación manual)</button>`).join('');
  }

  if(panelMode==='evaluar' && ['EN_REVISION','DERIVADO_SIMULADO'].includes(e.st)) {
    html+=`<div class="no-signal">Evaluación humana de prioridad. No confirma accidente ni mide precisión de IA. Puedes derivar sin completarla.</div>
      <label class="eval-label">Prioridad de revisión<select id="evalPrioridad">${['IND','P1','P2','P3'].map(n=>`<option value="${n}" ${e.p===n?'selected':''}>${n==='IND'?'Indeterminada':n+' · '+labels[n].split('·')[1].trim()}</option>`).join('')}</select></label>
      <label class="eval-label">Tipo observado<select id="evalTipo">${['Movimiento sospechoso','Otro','Video para revisar','Colisión','Colisión múltiple','Vuelco','Contacto leve'].map(n=>`<option ${e.tipo===n?'selected':''}>${escapeHTML(n)}</option>`).join('')}</select></label>
      <label class="eval-label">Base de la revisión<select id="evalFuente"><option value="video_revisado">Revisión visual del video</option><option value="relato_ciudadano">Información aportada por ciudadano</option><option value="sin_evidencia">Sin evidencia suficiente</option></select></label>
      <label class="eval-label">Motivo<textarea id="evalFundamento" minlength="8" maxlength="400" placeholder="Ej.: se observan varios vehículos inmóviles; sin confirmar impacto."></textarea></label>
      <div class="row"><button class="btn pri" data-action="confirmar-evaluar">Guardar evaluación</button><button class="btn" data-action="cancelar">Cancelar</button></div>`;
  } else if(e.st==='ALERTA_OPERADOR') {
    html+='<button class="btn pri" data-action="tomar">TOMAR CASO</button>';
  } else if(e.st==='EN_REVISION') {
    if(panelMode==='derivar') {
      html+='<span class="no-signal">Se guardará la derivación en el expediente; no implica despacho externo.</span>';
      html+=`<div class="row">${['SAMU 131','Bomberos 132','Carabineros 133'].map(s=>`<button class="sv ${selectedServices.includes(s)?'on':''}" data-service="${escapeHTML(s)}">${escapeHTML(s)}</button>`).join('')}</div>`;
      html+='<div class="row"><button class="btn pri" data-action="confirmar-derivar" '+(!selectedServices.length?'disabled':'')+'>Confirmar derivación</button><button class="btn" data-action="cancelar">Cancelar</button></div>';
    } else if (panelMode==='falsa') {
      html+='<select id="motivo" aria-label="Motivo obligatorio"><option value="">Motivo obligatorio...</option><option>Sombra o reflejo</option><option>Vehículo detenido normalmente</option><option>Obstrucción de cámara</option><option>Reporte ciudadano incorrecto</option><option>Otro, sin corroboración</option></select>';
      html+='<div class="row"><button class="btn pri" data-action="confirmar-falsa">Descartar alerta</button><button class="btn" data-action="cancelar">Cancelar</button></div>';
    } else {
      html+='<button class="btn pri" data-action="derivar">REGISTRAR DERIVACIÓN</button><button class="btn" data-action="evaluar">Evaluar gravedad y tipo (opcional)</button><div class="row"><button class="btn" data-action="falsa">Marcar falsa alarma</button><button class="btn" disabled title="Se debe derivar primero">Cerrar como atendido</button></div>';
    }
  } else if(e.st==='DERIVADO_SIMULADO') {
    html+='<div class="no-signal">Derivación registrada en el expediente.</div><button class="btn" data-action="evaluar">Evaluar gravedad y tipo (opcional)</button><button class="btn pri" data-action="cerrar">CERRAR COMO ATENDIDO</button>';
  } else {
    html+='<span class="nd">El caso ya está cerrado.</span>';
    html+=`<button class="btn archive-case" data-action="${e.archivado?'restaurar':'archivar'}">${e.archivado?'Restaurar al historial':'Archivar caso cerrado'}</button>`;
  }
  $('ctrl').innerHTML=html;
}
function drawMetrics() {
  $('kpis').innerHTML=store.metrics.map((m,i)=>{
    const title=escapeHTML(m.nombre);
    return `<div class="box k" title="${title}: ${escapeHTML(m.definicion)}. Meta: ${escapeHTML(m.meta)}">
      <small>${title}</small><div><b>${escapeHTML(m.value)}</b><em>meta ${escapeHTML(m.meta)}</em></div>
      <div class="sub ${!m.measured?'warn':''}">${escapeHTML(m.note)}</div></div>`;
  }).join('');
  // Separa el tiempo técnico del servidor del tiempo en que alguien abrió el panel
  // y del tiempo hasta una derivación manual (simulada).
  const op=store.tiempos_operativos||{};
  const valor=(n,u)=>n==null?'Sin datos':`${n} ${u}`;
  const ciudadanos=`Reportes ciudadanos descartados: ${op.reportes_ciudadanos_descartados??0}/${op.reportes_ciudadanos_total??0} (${op.reportes_ciudadanos_descartados_pct==null?'sin datos':op.reportes_ciudadanos_descartados_pct+' %'})`;
  const aux=document.getElementById('metricasExtra');
  if(aux) aux.innerHTML=`<div><b>Integridad mínima del registro</b><strong>${op.fichas_minimas_pct==null?'—':op.fichas_minimas_pct+' %'}</strong><small>${op.fichas_minimas_completas??0}/${op.fichas_minimas_total??0} con ID, fecha, origen, ubicación declarada, tipo, estado, prioridad y condición de evidencia registrada. Una casilla puede decir “desconocido”. No es el KPI estricto del Excel ni certifica un accidente.</small></div>
    <div><b>Evaluaciones del operador</b><strong>${op.casos_evaluados_operador??0}</strong><small>Casos con gravedad revisada manualmente y motivo registrado. No implica que un detector automático acertó.</small></div>
    <div><b>Concordancia con sugerencia inicial</b><strong>${op.coincidencias_sugerencia_pct==null?'—':op.coincidencias_sugerencia_pct+' %'}</strong><small>${op.coincidencias_sugerencia_operador??0}/${op.casos_evaluados_operador??0} evaluaciones coincidentes. Es acuerdo humano-reglas, NO precisión ni clasificación validada del Excel.</small></div>`;
  const el=document.getElementById('tiemposOperativos');
  if(el) el.textContent=`TIEMPOS OPERATIVOS · Procesamiento: ${valor(op.procesamiento_python_ms,'ms')} · Hasta primera vista en panel: ${valor(op.registro_a_primera_vista_s,'s')} · Hasta derivación del operador: ${valor(op.registro_a_derivacion_s,'s')}. No son tiempos de llegada de ambulancias ni de detección por IA. · ${ciudadanos}. Ver controles operativos complementarios para detalles.` ;
}
function drawAll({updateVideo=true,updateActions=true}={}) {
  ensureSelection();
  drawHeader();drawFeed();drawMap();drawDetails();drawMetrics();
  if(updateVideo)drawVideo();
  if(updateActions)drawActions();
}
async function refresh(showError=false) {
  if(requesting || !$('modalOverlay'))return;
  try {
    const state=await api('/api/estado'+(showExamples?'?ejemplos=1':''));
    // Avoid resetting the video and unfinished action forms during timed refresh.
    const oldCase=current();const oldSelected=selected;
    store=state;
    ensureSelection();
    const changed=oldSelected!==selected || !oldCase || oldCase.evidencia!==current()?.evidencia;
    drawAll({updateVideo:changed,updateActions:!panelMode});
    for(const e of state.events) {
      if(e.seed || e.visible_at || acking.has(e.id))continue;
      acking.add(e.id);
      api('/api/caso/visualizado',{id:e.id}).then(()=>refresh()).catch(()=>acking.delete(e.id));
    }
  }catch(err){if(showError)toast('No se puede conectar al sistema: '+err.message);}
}
async function post(path,data,msg) {
  try {await api(path,data);panelMode='';selectedServices=[];await refresh(true);if(msg)toast(msg);return true;}
  catch(err){toast('Error: '+err.message);return false;}
}

function showModal(type) {
  modalType=type;
  $('modalOverlay').classList.add('show');
  $('modalTitle').textContent=type==='camara'?'Registrar aviso de cámara':'Registrar reporte manual';
  $('modalHint').textContent=type==='camara'?
    'La información se registra manualmente y recibe una prioridad preliminar.':
    'El reporte se registra para revisión. El operador podrá asociarlo con otros avisos.';
  $('sendModal').textContent=type==='camara'?'Guardar aviso':'Enviar reporte';
  if(type==='camara') {
    $('modalFields').innerHTML=`<label>Evento<select name="tipo" required><option>Vuelco</option><option>Colisión múltiple</option><option selected>Colisión</option><option>Contacto leve</option><option>Movimiento sospechoso</option><option>Otro</option></select></label>
      <label>Identificador de cámara<input name="camara" value="CAM-REFERENCIA-01" required maxlength="60"></label>
      <label class="wide">Ubicación<input name="ubicacion" value="La Serena / Coquimbo (sector registrado)" required maxlength="220"></label>
      <label>Número de vehículos (0: desconocido)<input type="number" name="vehiculos" value="2" min="0" max="30" required></label>
      <label>Bloqueo de la vía<select name="bloqueo"><option>No</option><option selected>Parcial</option><option>Total</option><option>No determinado</option></select></label>
      <label>Visibilidad<select name="visibilidad"><option selected>Normal</option><option>Baja</option></select></label>
      <label>Niños a bordo (marcado MANUAL)<select name="ninos"><option value="no_determinada" selected>Sin determinar</option><option value="indicios_por_verificar">Indicios sin confirmar</option><option value="confirmada">Registrado por operador</option></select></label>
      <label class="wide">Señales observadas (escritas manualmente)<textarea name="descripcion" maxlength="500">Movimiento brusco y detención posterior</textarea></label>`;
  } else {
    const options=store.events.filter(e=>!e.seed && !closed(e) && e.camara).map(e=>`<option value="${escapeHTML(e.id)}">${escapeHTML(e.id)} · ${escapeHTML(e.tipo)}</option>`).join('');
    $('modalFields').innerHTML=`<label class="wide">Asociar con alerta de cámara (opcional)<select name="vincular_a"><option value="">Sin vincular: generar nuevo caso no verificado</option>${options}</select></label>
      <label class="wide">Ubicación reportada<input name="ubicacion" value="Coquimbo, sector centro" maxlength="220" required></label>
      <label class="wide">Descripción del reporte ciudadano<textarea name="descripcion" maxlength="500" required>Una persona informa un posible accidente en la vía</textarea></label>`;
  }
}
function hideModal(){modalType='';$('modalOverlay').classList.remove('show');}

async function actions(target) {
  const e=current();if(!e)return;
  const act=target.dataset.action;
  if(act==='archivar'||act==='restaurar'){
    const archival=act==='archivar';
    if(!confirm(archival?'¿Archivar este caso cerrado? Se ocultará en la app y el panel, pero sus datos e indicadores se conservarán.':'¿Restaurar este caso al historial de cerrados?'))return;
    if(await post('/api/caso/archivar',{id:e.id,archivado:archival},archival?'Caso archivado sin borrar datos.':'Caso recuperado.')){
      caseView=archival?'Cerrados':'Archivados';ensureSelection();drawAll();
    }
    return;
  }
  if(act==='evaluar'){panelMode='evaluar';drawActions();return;}
  if(act==='derivar'){panelMode='derivar';selectedServices=[];drawActions();return;}
  if(act==='falsa'){panelMode='falsa';drawActions();return;}
  if(act==='cancelar'){panelMode='';selectedServices=[];drawActions();return;}
  let payload={id:e.id};
  if(act==='tomar')payload.accion='tomar';
  else if(act==='confirmar-derivar') {payload.accion='derivar';payload.servicios=selectedServices;}
  else if(act==='confirmar-falsa') {payload.accion='falsa';payload.motivo=$('motivo')?.value||'';}
  else if(act==='cerrar')payload.accion='cerrar';
  else if(act==='confirmar-evaluar') {
    payload={...payload,accion:'evaluar',prioridad:$('evalPrioridad')?.value,
      tipo:$('evalTipo')?.value,fuente:$('evalFuente')?.value,
      fundamento:$('evalFundamento')?.value};
  }
  else return;
  if(await post('/api/caso/accion',payload,'Estado del incidente actualizado.'))drawActions();
}

document.addEventListener('click',async e=>{
  const target=e.target.closest('[data-filter],[data-id],[data-action],[data-service],[data-linkcam],[data-view]');
  if(!target)return;
  if(target.dataset.linkcam){
    const desde=current();const destino=target.dataset.linkcam;
    if(!desde || !confirm(`¿Confirmas que ${desde.id} y ${destino} corresponden al mismo incidente? La asociación requiere confirmación del operador.`))return;
    try{const result=await api('/api/caso/vincular',{id_app:desde.id,id_camara:destino});selected=result.id;filter='Todas';await refresh(true);toast('Reportes vinculados por el operador.');}
    catch(err){toast('Error al vincular: '+err.message)}
    return;
  }
  if(target.dataset.view){caseView=target.dataset.view;filter='Todas';panelMode='';ensureSelection();drawAll();return;}
  if(target.dataset.filter){filter=target.dataset.filter;drawFeed();return;}
  if(target.dataset.id){selected=target.dataset.id;panelMode='';selectedServices=[];drawAll();return;}
  if(target.dataset.service){const s=target.dataset.service;selectedServices=selectedServices.includes(s)?selectedServices.filter(x=>x!==s):[...selectedServices,s];drawActions();return;}
  if(target.dataset.action){await actions(target);return;}
});
$('th').onclick=()=>{const r=document.documentElement;const dark=r.dataset.theme?r.dataset.theme==='dark':matchMedia('(prefers-color-scheme:dark)').matches;r.dataset.theme=dark?'light':'dark';};
$('addCam').onclick=()=>showModal('camara');
$('addApp').onclick=()=>showModal('app');
$('cancelModal').onclick=hideModal;
$('modalOverlay').addEventListener('click',e=>{if(e.target===$('modalOverlay'))hideModal();});
$('newForm').onsubmit=async e=>{
  e.preventDefault();
  const data=Object.fromEntries(new FormData(e.currentTarget).entries());
  if(modalType==='camara')data.vehiculos=Number(data.vehiculos);
  const path=modalType==='camara'?'/api/camara/simular':'/api/app/reportar';
  try {
    const result=await api(path,data);
    const sentType=modalType;
    selected=result.id;filter='Todas';caseView='Activos';panelMode='';
    hideModal();await refresh(true);
    toast(sentType==='camara'?'Aviso registrado.':'Reporte registrado.');
  }catch(err){toast('Error: '+err.message);}
};
$('toggleExamples').onclick=async()=>{
  showExamples=!showExamples;
  caseView='Activos'; filter='Todas'; panelMode='';
  await refresh(true);
  toast(showExamples?'Ejemplos de referencia visibles.':'Ejemplos ocultos.');
};
setInterval(()=>$('clk').textContent=new Date().toLocaleTimeString('es-CL'),1000);
$('clk').textContent=new Date().toLocaleTimeString('es-CL');
refresh(true);
setInterval(()=>refresh(false),4000);

// Ambas entradas de video usan el mismo selector y la misma ruta Python.
// Los resultados son indicios visuales para revisión humana, nunca choques confirmados.
const abrirVideo=()=> $('videoFile').click();
$('subirVideo').onclick=abrirVideo;
$('subirVideoRapido').onclick=abrirVideo;
function estadoVideo(mensaje, tipo){
  const aviso=$('videoUploadStatus');
  aviso.hidden=!mensaje;
  aviso.textContent=mensaje;
  aviso.dataset.tipo=tipo||'';
}
function bloquearVideo(ocupado){
  $('subirVideo').disabled=ocupado;
  $('subirVideoRapido').disabled=ocupado;
  $('subirVideo').textContent=ocupado?'Subiendo video...':'🎬 Cargar otro video';
  const etiqueta=$('subirVideoRapido').querySelector('strong');
  if(etiqueta)etiqueta.textContent=ocupado?'PROCESANDO VIDEO...':'SUBIR VIDEO';
}
$('videoFile').onchange=async ev=>{
  const archivo=ev.target.files[0]; if(!archivo)return;
  if(archivo.size>60_000_000){
    estadoVideo('El archivo supera el máximo de 60 MB. Elige otro video.','error');
    ev.target.value='';return;
  }
  bloquearVideo(true);
  estadoVideo('Procesando '+archivo.name+'...','proceso');
  try{
    const url='/api/video/subir?nombre='+encodeURIComponent(archivo.name);
    const res=await fetch(url,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:archivo});
    const dat=await res.json(); if(!res.ok)throw Error(dat.error||'Error al cargar');
    selected=dat.id;filter='Todas';caseView='Activos';await refresh(true);
    estadoVideo('Video recibido: '+dat.id+'. Caso creado para revisión del operador. No es detección confirmada.','exito');
    toast('Video registrado como '+dat.id+'. Revisa la ficha y toma el caso.');
  }catch(e){
    estadoVideo('No se pudo subir el video: '+e.message,'error');
    toast('Error de video: '+e.message);
  }
  finally{bloquearVideo(false);ev.target.value='';}
};
