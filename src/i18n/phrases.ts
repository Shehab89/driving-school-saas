/**
 * Feedback phrase bank per language and stage: offered to instructors as
 * tap-to-add suggestions in the feedback composer (and used by the seed).
 */
export type Lang = "en" | "nl" | "ar";
export type Band = "early" | "mid" | "late";

export type Bank = Record<Band, { strengths: string[]; weaknesses: string[]; practice: string[]; next: string[] }>;

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

