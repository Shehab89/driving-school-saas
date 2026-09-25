/**
 * Content for the synthetic demo data (scripts/seed.ts). All people are
 * fictional. Feedback texts are written per language so each student reads
 * feedback in the language they use the app in.
 */
export type Lang = "en" | "nl" | "ar";
export type Band = "early" | "mid" | "late";

export interface PersonSeed {
  first: string;
  last: string;
  lang: Lang;
  transmission: "manual" | "automatic";
  /** Completed lessons so far (0 = new lead). */
  lessons: number;
  email?: string; // demo logins use fixed addresses
  instructor?: "john" | "fatima" | "sanne";
  dob: string;
}

export const INSTRUCTORS = {
  john: { first: "John", last: "de Vries", email: "john@abc.test", phone: "+31611111111", lang: "en" as Lang, color: "#1f6feb", car: "AB-123-C" },
  fatima: { first: "Fatima", last: "El Amrani", email: "fatima@abc.test", phone: "+31644444444", lang: "ar" as Lang, color: "#bf3989", car: "KL-456-M" },
  sanne: { first: "Sanne", last: "Visser", email: "sanne@abc.test", phone: "+31655555555", lang: "nl" as Lang, color: "#1a7f37", car: "XY-987-Z" },
};

export const VEHICLES = [
  { reg: "AB-123-C", brand: "Toyota", model: "Yaris", transmission: "manual" as const },
  { reg: "KL-456-M", brand: "Renault", model: "Clio", transmission: "manual" as const },
  { reg: "XY-987-Z", brand: "Volkswagen", model: "Polo", transmission: "automatic" as const },
  { reg: "PR-208-N", brand: "Peugeot", model: "208", transmission: "manual" as const },
];

/** Weekly working hours (ISO weekday, start, end). */
export const HOURS: Record<keyof typeof INSTRUCTORS, Array<[number, string, string]>> = {
  john: [[1, "08:00", "17:00"], [2, "08:00", "17:00"], [3, "08:00", "17:00"], [4, "08:00", "17:00"], [5, "08:00", "17:00"], [6, "09:00", "13:00"]],
  fatima: [[2, "10:00", "19:00"], [3, "10:00", "19:00"], [4, "10:00", "19:00"], [5, "10:00", "19:00"], [6, "09:00", "15:00"]],
  sanne: [[1, "08:00", "15:00"], [3, "08:00", "15:00"], [4, "08:00", "15:00"], [5, "08:00", "15:00"]],
};

export const STUDENTS: PersonSeed[] = [
  // Demo logins (one per language)
  { first: "Anna", last: "Jansen", lang: "nl", transmission: "manual", lessons: 12, email: "anna@abc.test", instructor: "john", dob: "2007-03-14" },
  { first: "Youssef", last: "El Idrissi", lang: "ar", transmission: "manual", lessons: 9, email: "youssef@abc.test", instructor: "fatima", dob: "2006-11-02" },
  { first: "Priya", last: "Sharma", lang: "en", transmission: "automatic", lessons: 7, email: "priya@abc.test", instructor: "sanne", dob: "1998-06-21" },
  { first: "Bram", last: "Bakker", lang: "nl", transmission: "manual", lessons: 3, email: "bram@abc.test", instructor: "john", dob: "2007-08-30" },
  // Dutch
  { first: "Daan", last: "de Boer", lang: "nl", transmission: "manual", lessons: 21, dob: "2006-01-09" },
  { first: "Emma", last: "Visscher", lang: "nl", transmission: "automatic", lessons: 16, dob: "2005-12-12" },
  { first: "Lotte", last: "Smit", lang: "nl", transmission: "manual", lessons: 5, dob: "2007-05-17" },
  { first: "Sem", last: "Meijer", lang: "nl", transmission: "manual", lessons: 1, dob: "2008-02-01" },
  { first: "Julia", last: "de Groot", lang: "nl", transmission: "automatic", lessons: 11, dob: "2004-09-25" },
  { first: "Lucas", last: "Mulder", lang: "nl", transmission: "manual", lessons: 8, dob: "2007-10-04" },
  { first: "Finn", last: "Vos", lang: "nl", transmission: "manual", lessons: 18, dob: "2006-04-22" },
  { first: "Sophie", last: "Peters", lang: "nl", transmission: "manual", lessons: 2, dob: "2007-07-07" },
  { first: "Levi", last: "Hendriks", lang: "nl", transmission: "manual", lessons: 14, dob: "2006-06-15" },
  { first: "Mila", last: "Dekker", lang: "nl", transmission: "automatic", lessons: 6, dob: "2005-02-28" },
  { first: "Noa", last: "Bos", lang: "nl", transmission: "manual", lessons: 0, dob: "2008-01-19" },
  // Arabic-speaking
  { first: "Amina", last: "Benali", lang: "ar", transmission: "manual", lessons: 15, dob: "2005-03-03" },
  { first: "Omar", last: "Haddad", lang: "ar", transmission: "manual", lessons: 22, dob: "2001-08-11" },
  { first: "Layla", last: "Mansour", lang: "ar", transmission: "automatic", lessons: 4, dob: "1995-12-01" },
  { first: "Karim", last: "Aziz", lang: "nl", transmission: "manual", lessons: 10, dob: "2006-09-09" },
  { first: "Nour", last: "Saleh", lang: "ar", transmission: "manual", lessons: 6, dob: "2004-04-04" },
  { first: "Hamza", last: "Bouzid", lang: "ar", transmission: "manual", lessons: 0, dob: "2007-12-24" },
  { first: "Rania", last: "Khalil", lang: "ar", transmission: "automatic", lessons: 13, dob: "1990-05-16" },
  { first: "Ibrahim", last: "Nasser", lang: "ar", transmission: "manual", lessons: 2, dob: "2003-10-30" },
  { first: "Salma", last: "Tahiri", lang: "nl", transmission: "manual", lessons: 17, dob: "2006-02-14" },
  // International
  { first: "Mateo", last: "García", lang: "en", transmission: "manual", lessons: 0, dob: "1999-07-08" },
  { first: "Chen", last: "Wei", lang: "en", transmission: "automatic", lessons: 9, dob: "1997-01-27" },
  { first: "Olga", last: "Petrova", lang: "en", transmission: "manual", lessons: 12, dob: "1993-11-11" },
  { first: "Liam", last: "O'Brien", lang: "en", transmission: "manual", lessons: 5, dob: "2000-03-18" },
  { first: "Aylin", last: "Yılmaz", lang: "nl", transmission: "manual", lessons: 19, dob: "2005-08-05" },
  { first: "Tom", last: "Williams", lang: "en", transmission: "automatic", lessons: 3, dob: "1996-09-29" },
];

type Bank = Record<Band, { strengths: string[]; weaknesses: string[]; practice: string[]; next: string[] }>;

export const FEEDBACK: Record<Lang, Bank> = {
  en: {
    early: {
      strengths: ["Good seating position and mirror setup before driving off.", "Smooth moving off on the flat, well done.", "Calm and attentive, listened well to instructions.", "Steering is steady on straight roads."],
      weaknesses: ["Clutch control on hill starts still stalls now and then.", "Looks down at the pedals when changing gear.", "Brakes late when approaching junctions.", "Forgets the blind-spot check before moving off."],
      practice: ["Hill starts in the car park: find the biting point without looking.", "Say the mirror–signal–manoeuvre routine out loud at every turn.", "Gear changes 1→2→3 on a quiet road.", "Moving off with a shoulder check, ten times in a row."],
      next: ["Quiet junctions left and right", "Clutch control on slopes", "Mirrors before every speed change", "First short drive in light traffic"],
    },
    mid: {
      strengths: ["Handled the multi-lane roundabout calmly and chose the right lane.", "Good speed choice in the 30 zones.", "Anticipated the cyclists at the crossing very well.", "Confident in busier city traffic today."],
      weaknesses: ["Signals too late when leaving roundabouts.", "Lane choice before traffic lights is sometimes late.", "Hesitates at priority-to-the-right junctions.", "Follows too closely behind buses."],
      practice: ["Roundabout exits: signal right after passing the exit before yours.", "Read road markings earlier and sort into lanes on time.", "Priority rules at equal junctions (right has priority).", "Keep a two-second gap in town."],
      next: ["Roundabouts with two lanes", "Priority rules in residential areas", "Hazard perception in busy streets", "Driving on the ring road"],
    },
    late: {
      strengths: ["Excellent motorway merge, good use of the acceleration lane.", "Parallel parking done in one smooth attempt.", "Independent driving to Amstelveen without any help.", "Mock test route driven at exam level."],
      weaknesses: ["Speed creeps above 100 on the motorway.", "Bay parking ends slightly crooked.", "Checks the mirror late before changing lanes on the A10.", "Nervous at the start of the mock test."],
      practice: ["Keep the speedometer in view on long straight roads.", "Reverse bay parking using the side mirrors as reference.", "Mirror and shoulder check before every lane change.", "Breathing routine before starting the drive."],
      next: ["Full mock exam", "Motorway exits and weaving sections", "Special manoeuvres: turning in the road", "Night-time drive"],
    },
  },
  nl: {
    early: {
      strengths: ["Goede zithouding en spiegels goed afgesteld voor vertrek.", "Soepel weggereden op vlak terrein, goed zo.", "Rustig en geconcentreerd, luisterde goed naar de aanwijzingen.", "Stuurt stabiel op rechte wegen."],
      weaknesses: ["Koppeling bij hellingproef slaat nog af en toe af.", "Kijkt naar de pedalen bij het schakelen.", "Remt laat bij het naderen van kruispunten.", "Vergeet de dodehoekcontrole bij het wegrijden."],
      practice: ["Hellingproef op de parkeerplaats: aangrijpingspunt vinden zonder te kijken.", "Spiegels–richting–manoeuvre hardop benoemen bij elke afslag.", "Schakelen van 1 naar 2 naar 3 op een rustige weg.", "Tien keer wegrijden met schoudercheck."],
      next: ["Rustige kruispunten links en rechts", "Koppeling op hellingen", "Spiegels bij elke snelheidswijziging", "Eerste korte rit in licht verkeer"],
    },
    mid: {
      strengths: ["Rustig over de meerstrooksrotonde en de juiste strook gekozen.", "Goede snelheid in de 30-zones.", "Fietsers bij de oversteek goed ingeschat.", "Vandaag zelfverzekerd in druk stadsverkeer."],
      weaknesses: ["Geeft te laat richting aan bij het verlaten van rotondes.", "Voorsorteren voor stoplichten gebeurt soms laat.", "Twijfelt bij gelijkwaardige kruispunten.", "Rijdt te dicht achter bussen."],
      practice: ["Rotonde verlaten: richting aangeven na de afslag vóór de jouwe.", "Wegmarkeringen eerder lezen en op tijd voorsorteren.", "Voorrangsregels op gelijkwaardige kruispunten (rechts gaat voor).", "Twee seconden afstand houden in de stad."],
      next: ["Rotondes met twee rijstroken", "Voorrang in woonwijken", "Gevaarherkenning in drukke straten", "Rijden op de ring"],
    },
    late: {
      strengths: ["Uitstekend ingevoegd op de snelweg, invoegstrook goed benut.", "Fileparkeren in één vloeiende poging.", "Zelfstandig naar Amstelveen gereden zonder hulp.", "Proefexamenroute op examenniveau gereden."],
      weaknesses: ["Snelheid loopt op de snelweg op boven de 100.", "Vakparkeren eindigt iets scheef.", "Kijkt laat in de spiegel voor het wisselen van rijstrook op de A10.", "Zenuwachtig aan het begin van het proefexamen."],
      practice: ["Snelheidsmeter in de gaten houden op lange rechte stukken.", "Achteruit vakparkeren met de zijspiegels als referentie.", "Spiegel en schoudercheck voor elke rijstrookwissel.", "Ademhalingsoefening voor vertrek."],
      next: ["Volledig proefexamen", "Afritten en weefvakken op de snelweg", "Bijzondere verrichting: keren", "Rit in het donker"],
    },
  },
  ar: {
    early: {
      strengths: ["وضعية جلوس جيدة وضبط صحيح للمرايا قبل الانطلاق.", "انطلاق سلس على الطريق المستوي، أحسنت.", "هادئ ومركّز، واستمع جيدًا للتعليمات.", "التحكم في المقود ثابت على الطرق المستقيمة."],
      weaknesses: ["التحكم في القابض عند الانطلاق على المنحدر ما زال يتوقف أحيانًا.", "ينظر إلى الدواسات أثناء تبديل السرعات.", "يضغط على الفرامل متأخرًا عند الاقتراب من التقاطعات.", "ينسى فحص النقطة العمياء قبل الانطلاق."],
      practice: ["تمرين الانطلاق على المنحدر في موقف السيارات دون النظر إلى الدواسات.", "قل روتين المرآة ثم الإشارة ثم المناورة بصوت عالٍ عند كل منعطف.", "تبديل السرعات من الأولى إلى الثالثة على طريق هادئ.", "الانطلاق مع النظر فوق الكتف عشر مرات متتالية."],
      next: ["التقاطعات الهادئة يسارًا ويمينًا", "التحكم في القابض على المنحدرات", "النظر في المرايا قبل كل تغيير في السرعة", "أول قيادة قصيرة في حركة مرور خفيفة"],
    },
    mid: {
      strengths: ["عبور الدوار متعدد المسارات بهدوء واختيار المسار الصحيح.", "اختيار سرعة مناسب في مناطق الثلاثين.", "توقع جيد جدًا لراكبي الدراجات عند المعبر.", "ثقة واضحة اليوم في حركة المدينة المزدحمة."],
      weaknesses: ["يستخدم الإشارة متأخرًا عند الخروج من الدوارات.", "اختيار المسار قبل الإشارات الضوئية يأتي متأخرًا أحيانًا.", "يتردد عند التقاطعات المتساوية الأولوية.", "يقترب كثيرًا من الحافلات."],
      practice: ["الخروج من الدوار: شغّل الإشارة بعد تجاوز المخرج الذي يسبق مخرجك.", "اقرأ علامات الطريق مبكرًا واختر المسار في الوقت المناسب.", "قواعد الأولوية عند التقاطعات المتساوية (الأولوية لليمين).", "حافظ على مسافة ثانيتين داخل المدينة."],
      next: ["الدوارات ذات المسارين", "قواعد الأولوية في الأحياء السكنية", "إدراك المخاطر في الشوارع المزدحمة", "القيادة على الطريق الدائري"],
    },
    late: {
      strengths: ["اندماج ممتاز في الطريق السريع واستخدام جيد لمسار التسارع.", "الركن الموازي تم في محاولة واحدة سلسة.", "قيادة مستقلة إلى أمستلفين دون أي مساعدة.", "قيادة مسار الامتحان التجريبي بمستوى الامتحان."],
      weaknesses: ["السرعة ترتفع فوق 100 على الطريق السريع.", "الركن في الموقف ينتهي مائلًا قليلًا.", "ينظر في المرآة متأخرًا قبل تغيير المسار على A10.", "توتر في بداية الامتحان التجريبي."],
      practice: ["راقب عداد السرعة على الطرق المستقيمة الطويلة.", "الركن للخلف في الموقف باستخدام المرايا الجانبية كمرجع.", "انظر في المرآة وفوق الكتف قبل كل تغيير للمسار.", "تمرين التنفس قبل بدء القيادة."],
      next: ["امتحان تجريبي كامل", "مخارج الطريق السريع ومناطق التداخل", "مناورة خاصة: الالتفاف في الطريق", "القيادة ليلًا"],
    },
  },
};

/** Synthetic WhatsApp conversations (the agent's side as it would answer). */
export interface Chat {
  student: string; // first name of a STUDENTS entry
  status: "open" | "handoff";
  handoffReason?: string;
  messages: Array<{ from: "contact" | "ai_agent" | "staff"; text: string; intent?: string; tools?: string[] }>;
}

export const CHATS: Chat[] = [
  {
    student: "Hamza",
    status: "open",
    messages: [
      { from: "contact", text: "السلام عليكم، أريد أن أتعلم القيادة", intent: "new_student", tools: ["record_intent"] },
      { from: "ai_agent", text: "وعليكم السلام! أهلًا بك في ABC Driving School. هل أنت طالب لدينا بالفعل؟" },
      { from: "contact", text: "لا، أنا جديد. اسمي حمزة بوزيد، hamza.bouzid@mail.test، رخصة B، يدوي. أفضل بعد الظهر.", intent: "new_student", tools: ["record_intent", "register_new_student"] },
      { from: "ai_agent", text: "شكرًا حمزة، تم تسجيلك. بعض الأسئلة القصيرة: هل قدت سيارة من قبل؟ وكم درسًا أخذت؟" },
      { from: "contact", text: "قدت قليلًا مع والدي في موقف السيارات، ولم آخذ دروسًا. أنا متوتر قليلًا في الزحام، 2 من 5.", intent: "new_student", tools: ["record_intent", "submit_assessment"] },
      { from: "ai_agent", text: "بناءً على إجاباتك، مستوى البداية المقترح هو: المستوى 1 – التحكم في السيارة. سيؤكد المدرب ذلك في درسك الأول. هل تريد أن أبحث لك عن موعد؟" },
    ],
  },
  {
    student: "Noa",
    status: "open",
    messages: [
      { from: "contact", text: "Hoi! Wat kost een rijles bij jullie?", intent: "prices", tools: ["record_intent", "get_school_info"] },
      { from: "ai_agent", text: "Hoi! Een les van 60 minuten kost €55. Een pakket van 10 lessen kost €520. Ben je al leerling bij ons?" },
      { from: "contact", text: "Nee nog niet. Ik ben Noa Bos, noa.bos@mail.test, rijbewijs B, schakel. Liefst op woensdagmiddag.", intent: "new_student", tools: ["record_intent", "register_new_student"] },
      { from: "ai_agent", text: "Top, Noa, je bent ingeschreven! Nog een paar korte vragen: heb je al eens gereden, en hoe voel je je in het verkeer op een schaal van 1 tot 5?" },
    ],
  },
  {
    student: "Mateo",
    status: "open",
    messages: [
      { from: "contact", text: "Hi, I have a Spanish licence, do I need lessons to drive in NL?", intent: "school_info", tools: ["record_intent", "get_school_info"] },
      { from: "ai_agent", text: "Hi! An EU licence is valid in the Netherlands, so you don't need to retake it. Many drivers still book a few lessons to get used to Dutch traffic, like cyclists and priority rules. Would you like me to sign you up?" },
      { from: "contact", text: "Yes please. Mateo García, mateo.garcia@mail.test, manual.", intent: "new_student", tools: ["record_intent", "register_new_student", "submit_assessment"] },
      { from: "ai_agent", text: "Done! Based on your answers, your suggested starting level is Level 4 – Advanced. An instructor will confirm this during your first lesson." },
    ],
  },
  {
    student: "Youssef",
    status: "open",
    messages: [
      { from: "contact", text: "متى درسي القادم؟", intent: "check_upcoming_lesson", tools: ["record_intent", "get_my_lessons"] },
      { from: "ai_agent", text: "درسك القادم مع فاطمة. يمكنك رؤية التفاصيل وإعادة الجدولة من تطبيق الطالب حتى 24 ساعة قبل الموعد." },
      { from: "contact", text: "شكرًا 🙏", intent: "other", tools: ["record_intent"] },
      { from: "ai_agent", text: "عفوًا! بالتوفيق في درسك." },
    ],
  },
  {
    student: "Lotte",
    status: "handoff",
    handoffReason: "Complaint about a cancelled lesson",
    messages: [
      { from: "contact", text: "Mijn les van gisteren is geannuleerd en ik moet toch betalen?? Dat vind ik niet oké.", intent: "human_support", tools: ["record_intent", "request_human"] },
      { from: "ai_agent", text: "Wat vervelend, Lotte. Ik heb je vraag doorgezet naar de rijschool; iemand van het team reageert hier zo snel mogelijk." },
      { from: "staff", text: "Hoi Lotte, Olivia hier. Je hebt gelijk, de annulering kwam van onze kant. Ik heb de kosten geschrapt. Excuses!" },
    ],
  },
];
