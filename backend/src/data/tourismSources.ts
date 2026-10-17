/**
 * Official national tourism sites, one per country, keyed by the ISO 3166-1
 * alpha-2 code that Nominatim returns for a geocoded area.
 *
 * These are government or state-agency sites. Their text is public and is used
 * here the same way a user-supplied "additional source" is: fetched, reduced to
 * plain text, and mined for passages about a specific place. Their photographs
 * fill in for places the openly licensed sources left short; unlike Commons
 * and Openverse imagery they are all rights reserved, and are credited and
 * marked so (services/tourismImages.ts).
 *
 * Every URL below was opened over HTTP on 25 Sep 2026; 182 of 196 countries
 * have one. On 10 Oct 2026 twelve entries were found not to be national
 * tourism sites (a clinic, a zoo, a gambling regulator, city sites...) and
 * were replaced with the country's real one, or removed where none could be
 * confirmed. Sourced from Wikidata, Wikipedia category members and, where those
 * were empty or wrong, a web search whose result was then opened and read.
 * Countries with no confirmed national site are simply absent.
 */

export interface TourismSource {
  /** English country name, for log lines and job notes. */
  country: string;
  /** The body that runs the site. */
  organisation: string;
  /** Entry point. A crawl starts here and never leaves this host. */
  url: string;
}

export const TOURISM_SOURCES: Readonly<Record<string, TourismSource>> = {
  AD: {
    country: "Andorra",
    organisation: "Ministry of Tourism of Andorra",
    url: "https://www.turisme.ad/",
  },
  AE: {
    country: "United Arab Emirates",
    organisation: "UAE Government platform — visiting the UAE",
    url: "https://u.ae/en/information-and-services/visiting-and-exploring-the-uae",
  },
  AF: {
    country: "Afghanistan",
    organisation: "Ministry of Information and Culture (tourism)",
    url: "https://moic.gov.af/en",
  },
  AG: {
    country: "Antigua and Barbuda",
    organisation: "Antigua and Barbuda Tourism Authority",
    url: "https://www.visitantiguabarbuda.com/",
  },
  AL: {
    country: "Albania",
    organisation: "Ministry of Tourism, Culture and Sports",
    url: "https://mtks.gov.al/",
  },
  AM: {
    country: "Armenia",
    organisation: "Tourism Committee of Armenia",
    url: "https://armenia.travel/",
  },
  AO: {
    country: "Angola",
    organisation: "Visit Angola (Angola Tourism Board)",
    url: "https://www.visitangola.com",
  },
  AR: {
    country: "Argentina",
    organisation: "Secretariat of Tourism, Environment and Sports of Argentina",
    url: "https://www.argentina.gob.ar/interior/secretaria-de-turismo-ambiente-y-deportes",
  },
  AT: {
    country: "Austria",
    organisation: "Austrian National Tourist Office",
    url: "http://www.austriatourism.com",
  },
  AU: {
    country: "Australia",
    organisation: "Tourism Australia",
    url: "https://www.australia.com/",
  },
  AZ: {
    country: "Azerbaijan",
    organisation: "State Tourism Agency of the Republic of Azerbaijan",
    url: "https://tourism.gov.az/",
  },
  BA: {
    country: "Bosnia and Herzegovina",
    organisation: "Official tourism site",
    url: "https://www.fmoit.gov.ba/",
  },
  BB: {
    country: "Barbados",
    organisation: "Barbados Tourism Marketing Inc.",
    url: "https://www.visitbarbados.org/",
  },
  BD: {
    country: "Bangladesh",
    organisation: "Ministry of Civil Aviation and Tourism",
    url: "https://mocat.gov.bd/",
  },
  BE: {
    country: "Belgium",
    organisation: "Visit Belgium (tourism is regionalised)",
    url: "https://visitbelgium.com/en",
  },
  BF: {
    country: "Burkina Faso",
    organisation: "Office National du Tourisme Burkinabe (ONTB)",
    url: "https://www.ontb.bf/",
  },
  BG: {
    country: "Bulgaria",
    organisation: "Ministry of Tourism",
    url: "http://www.tourism.government.bg/",
  },
  BH: {
    country: "Bahrain",
    organisation: "Bahrain Tourism and Exhibitions Authority",
    url: "https://www.btea.bh",
  },
  BJ: {
    country: "Benin",
    organisation: "Government of Benin — tourism sector",
    url: "https://benin.bj/en/sectors/tourism",
  },
  BN: {
    country: "Brunei",
    organisation: "Brunei Tourism — Abode of Peace",
    url: "https://www.bruneitourism.com/",
  },
  BO: {
    country: "Bolivia",
    organisation: "Ministerio de Turismo, Culturas, Folklore y Gastronomia",
    url: "https://conocebolivia.turismoyculturas.gob.bo/",
  },
  BR: {
    country: "Brazil",
    organisation: "Ministry of Tourism",
    url: "http://www.turismo.gov.br",
  },
  BS: {
    country: "The Bahamas",
    organisation: "Ministry of Tourism, Investments and Aviation",
    url: "https://www.bahamas.com",
  },
  BT: {
    country: "Bhutan",
    organisation: "Department of Tourism, Bhutan",
    url: "https://bhutan.travel/",
  },
  BW: {
    country: "Botswana",
    organisation: "Botswana Tourism Organisation",
    url: "https://www.botswanatourism.co.bw/",
  },
  BY: {
    country: "Belarus",
    organisation: "Ministry of Sports of the Republic of Belarus",
    url: "http://www.mst.by/",
  },
  BZ: {
    country: "Belize",
    organisation: "Belize Tourism Board",
    url: "https://www.belizetourismboard.org/",
  },
  CA: {
    country: "Canada",
    organisation: "Destination Canada",
    url: "https://travel.destinationcanada.com/",
  },
  CH: {
    country: "Switzerland",
    organisation: "Switzerland Tourism — MySwitzerland",
    url: "https://www.myswitzerland.com/",
  },
  CI: {
    country: "Ivory Coast",
    organisation: "Ministry of Tourism and Leisure",
    url: "https://www.tourisme.gouv.ci/",
  },
  CL: {
    country: "Chile",
    organisation: "Servicio Nacional de Turismo",
    url: "http://www.sernatur.cl/",
  },
  CM: {
    country: "Cameroon",
    organisation: "Ministry of Tourism and Leisure (MINTOUL)",
    url: "https://mintoul.gov.cm/en/",
  },
  CN: {
    country: "People's Republic of China",
    organisation: "Ministry of Culture and Tourism of the PRC",
    url: "https://www.travelchina.org.cn/en",
  },
  CO: {
    country: "Colombia",
    organisation: "ProColombia — Colombia Travel",
    url: "https://colombia.travel/en",
  },
  CR: {
    country: "Costa Rica",
    organisation: "Costa Rican Tourism Board",
    url: "https://www.ict.go.cr/es/",
  },
  CU: {
    country: "Cuba",
    organisation: "Ministry of Tourism of Cuba",
    url: "https://www.mintur.gob.cu/",
  },
  CV: {
    country: "Cape Verde",
    organisation: "Travel Cabo Verde (government portal)",
    url: "https://travel.gov.cv/",
  },
  CY: {
    country: "Cyprus",
    organisation: "Deputy Ministry Of Tourism (Cyprus)",
    url: "https://www.gov.cy/tourism/",
  },
  CZ: {
    country: "Czech Republic",
    organisation: "CzechTourism",
    url: "https://www.czechtourism.cz",
  },
  DE: {
    country: "Germany",
    organisation: "Deutsche Zentrale für Tourismus",
    url: "http://www.germany.travel/",
  },
  DJ: {
    country: "Djibouti",
    organisation: "Agence Nationale du Tourisme de Djibouti",
    url: "https://guide.visitdjibouti.dj/",
  },
  DM: {
    country: "Dominica",
    organisation: "Discover Dominica Authority",
    url: "https://discoverdominica.com/",
  },
  DO: {
    country: "Dominican Republic",
    organisation: "Ministry of Tourism of the Dominican Republic",
    url: "http://www.mitur.gob.do/",
  },
  DZ: {
    country: "Algeria",
    organisation: "Ministry of Tourism and Handicrafts (Algeria)",
    url: "https://www.mta.gov.dz/?lang=en",
  },
  EC: {
    country: "Ecuador",
    organisation: "Ministerio de Turismo — Ecuador Travel",
    url: "https://ecuador.travel/en/",
  },
  EE: {
    country: "Estonia",
    organisation: "Visit Estonia",
    url: "https://visitestonia.com/en",
  },
  EG: {
    country: "Egypt",
    organisation: "Ministry of Tourism and Antiquities",
    url: "https://www.mota.gov.eg/",
  },
  ES: {
    country: "Spain",
    organisation: "Turespaña",
    url: "http://www.tourspain.es",
  },
  ET: {
    country: "Ethiopia",
    organisation: "Visit Ethiopia / Ministry of Tourism",
    url: "https://visitethiopia.et/",
  },
  FI: {
    country: "Finland",
    organisation: "Visit Finland",
    url: "https://www.visitfinland.com/en/",
  },
  FJ: {
    country: "Fiji",
    organisation: "Tourism Fiji",
    url: "https://www.fiji.travel/",
  },
  FM: {
    country: "Federated States of Micronesia",
    organisation: "Tourism FSM",
    url: "https://visit-micronesia.fm/",
  },
  FR: {
    country: "France",
    organisation: "Atout France — Explore France",
    url: "https://www.france.fr/en/",
  },
  GB: {
    country: "United Kingdom",
    organisation: "VisitBritain (British Tourist Authority)",
    url: "https://www.visitbritain.com/en",
  },
  GD: {
    country: "Grenada",
    organisation: "Ministry of Economic Development, Planning, Tourism, Creative Economy, Culture, Agriculture and Lands, Forestry, Blue Economy, Marine Resources and Cooperatives of Grenada",
    url: "https://www.gov.gd/index.php/econdev",
  },
  GE: {
    country: "Georgia",
    organisation: "Georgian National Tourism Administration",
    url: "https://georgia.travel/",
  },
  GH: {
    country: "Ghana",
    organisation: "Ghana Tourism Authority",
    url: "https://visitghana.com/",
  },
  GM: {
    country: "The Gambia",
    organisation: "Gambia Tourism Board",
    url: "https://visitthegambia.com/",
  },
  GN: {
    country: "Guinea",
    organisation: "Official tourism site (Guinea)",
    url: "https://tourisme.gov.gn/",
  },
  GR: {
    country: "Greece",
    organisation: "Greek National Tourism Organisation",
    url: "https://www.visitgreece.gr/",
  },
  GT: {
    country: "Guatemala",
    organisation: "INGUAT — Visit Guatemala",
    url: "https://visitguatemala.gt/en/",
  },
  GY: {
    country: "Guyana",
    organisation: "Guyana Tourism Authority",
    url: "https://guyanatourism.com/",
  },
  HN: {
    country: "Honduras",
    organisation: "Instituto Hondureno de Turismo (IHT)",
    url: "https://iht.hn/en",
  },
  HR: {
    country: "Croatia",
    organisation: "Croatian National Tourist Board",
    url: "https://croatia.hr",
  },
  HT: {
    country: "Haiti",
    organisation: "Ministere du Tourisme d'Haiti",
    url: "https://www.tourisme.gouv.ht/",
  },
  HU: {
    country: "Hungary",
    organisation: "tourism in Hungary",
    url: "http://itthon.hu/",
  },
  ID: {
    country: "Indonesia",
    organisation: "Ministry of Tourism — Wonderful Indonesia",
    url: "https://www.indonesia.travel/gb/en",
  },
  IE: {
    country: "Ireland",
    organisation: "Fáilte Ireland",
    url: "http://www.failteireland.ie/",
  },
  IL: {
    country: "Israel",
    organisation: "Israel Ministry of Tourism — official tourist information",
    url: "https://www.goisrael.com/",
  },
  IN: {
    country: "India",
    organisation: "Incredible India",
    url: "http://www.incredibleindia.org/",
  },
  IQ: {
    country: "Iraq",
    organisation: "Ministry of Culture, Tourism and Antiquities",
    url: "https://www.mocul.gov.iq/",
  },
  IR: {
    country: "Iran",
    organisation: "Ministry of Cultural Heritage, Tourism and Handicrafts",
    url: "https://www.mcth.ir",
  },
  IS: {
    country: "Iceland",
    organisation: "Visit Iceland / Icelandic Tourist Board",
    url: "https://www.visiticeland.com/",
  },
  IT: {
    country: "Italy",
    organisation: "Ministry of Tourism of Italy",
    url: "https://www.ministeroturismo.gov.it",
  },
  JM: {
    country: "Jamaica",
    organisation: "Ministry of Tourism",
    url: "https://www.mot.gov.jm",
  },
  JO: {
    country: "Jordan",
    organisation: "Jordan Tourism Board",
    url: "https://international.visitjordan.com/",
  },
  JP: {
    country: "Japan",
    organisation: "Japan National Tourism Organization — Travel Japan",
    url: "https://www.japan.travel/en/",
  },
  KE: {
    country: "Kenya",
    organisation: "Kenya Tourism Board — Magical Kenya",
    url: "https://ktb.go.ke/",
  },
  KG: {
    country: "Kyrgyzstan",
    organisation: "Ministry of Culture, Information and Tourism",
    url: "http://www.minculture.gov.kg",
  },
  KH: {
    country: "Cambodia",
    organisation: "Ministry of Tourism, Cambodia",
    url: "https://www.tourism.gov.kh/",
  },
  KI: {
    country: "Kiribati",
    organisation: "Tourism Authority of Kiribati",
    url: "http://www.kiribatitourism.gov.ki/",
  },
  KM: {
    country: "Comoros",
    organisation: "National Directorate of Tourism, Comoros",
    url: "https://www.tourisme.gouv.km/",
  },
  KN: {
    country: "Saint Kitts and Nevis",
    organisation: "St Kitts Tourism Authority",
    url: "https://www.visitstkitts.com/",
  },
  KP: {
    country: "North Korea",
    organisation: "State General Bureau of Tourist Guidance",
    url: "http://tourismdprk.gov.kp/",
  },
  KR: {
    country: "South Korea",
    organisation: "Korea Tourism Organization",
    url: "https://kto.visitkorea.or.kr/kor.kto",
  },
  KW: {
    country: "Kuwait",
    organisation: "Kuwait Government Online — Tourism in Kuwait",
    url: "https://www.kuwaittourism.com/",
  },
  KZ: {
    country: "Kazakhstan",
    organisation: "Ministry of Tourism and Sports of the Republic of Kazakhstan",
    url: "https://www.gov.kz/memleket/entities/tsm?lang=kk",
  },
  LA: {
    country: "Laos",
    organisation: "Lao National Tourism Administration",
    url: "https://www.tourismlaos.org/",
  },
  LB: {
    country: "Lebanon",
    organisation: "Ministry of Tourism, Lebanon",
    url: "https://mot.gov.lb/en/landing/",
  },
  LC: {
    country: "Saint Lucia",
    organisation: "Saint Lucia Tourism Authority",
    url: "https://stlucia.org/en/",
  },
  LI: {
    country: "Liechtenstein",
    organisation: "Liechtenstein Marketing",
    url: "https://tourismus.li/en",
  },
  LK: {
    country: "Sri Lanka",
    organisation: "Ministry of Tourism",
    url: "http://www.tourismmin.gov.lk/",
  },
  LR: {
    country: "Liberia",
    organisation: "Liberia National Tourism Authority",
    url: "https://enjoyliberia.travel/",
  },
  LS: {
    country: "Lesotho",
    organisation: "Lesotho Tourism Development Corporation",
    url: "https://visitlesotho.org.ls/",
  },
  LT: {
    country: "Lithuania",
    organisation: "Lithuania Travel",
    url: "https://lithuania.travel/en",
  },
  LU: {
    country: "Luxembourg",
    organisation: "Luxembourg for Tourism — Visit Luxembourg",
    url: "https://www.visitluxembourg.com/",
  },
  LV: {
    country: "Latvia",
    organisation: "Latvia Travel (LIAA Tourism Department)",
    url: "https://www.latvia.travel/en",
  },
  MA: {
    country: "Morocco",
    organisation: "Ministry of Tourism, Handicrafts and Social and Solidarity Economy",
    url: "https://mtaess.gov.ma/fr/tourisme/",
  },
  MC: {
    country: "Monaco",
    organisation: "Monaco Government Tourist and Convention Authority — Visit Monaco",
    url: "https://www.visitmonaco.com/",
  },
  MD: {
    country: "Moldova",
    organisation: "Moldova.Travel — National Tourism Office",
    url: "https://moldova.travel/en/",
  },
  ME: {
    country: "Montenegro",
    organisation: "National Tourism Organisation of Montenegro",
    url: "https://www.montenegro.travel/en",
  },
  MG: {
    country: "Madagascar",
    organisation: "tourism in Madagascar",
    url: "https://madagascar-tourisme.com/en",
  },
  MH: {
    country: "Marshall Islands",
    organisation: "Marshall Islands Visitors Authority",
    url: "https://www.visitmarshallislands.mh/",
  },
  MK: {
    country: "North Macedonia",
    organisation: "North Macedonia Timeless",
    url: "https://macedonia-timeless.com/eng",
  },
  ML: {
    country: "Mali",
    organisation: "Office Malien du Tourisme et de l'Hotellerie (OMATHO)",
    url: "https://www.omatho.com",
  },
  MM: {
    country: "Myanmar",
    organisation: "Ministry of Hotels and Tourism",
    url: "https://tourism.gov.mm/",
  },
  MN: {
    country: "Mongolia",
    organisation: "Ministry of Culture, Sports, Tourism and Youth of Mongolia",
    url: "https://mocsty.gov.mn/",
  },
  MT: {
    country: "Malta",
    organisation: "Malta Tourism Authority — Visit Malta",
    url: "https://www.visitmalta.com/en/",
  },
  MU: {
    country: "Mauritius",
    organisation: "Mauritius Tourism Promotion Authority",
    url: "https://www.mymauritius.travel/",
  },
  MV: {
    country: "Maldives",
    organisation: "Visit Maldives Corporation",
    url: "https://visitmaldives.com/en",
  },
  MW: {
    country: "Malawi",
    organisation: "Department of Tourism — Visit Malawi",
    url: "https://visitmalawi.mw/",
  },
  MX: {
    country: "Mexico",
    organisation: "SECTUR — Visit Mexico",
    url: "https://visitmexico.com/en/",
  },
  MY: {
    country: "Malaysia",
    organisation: "Ministry of Tourism, Arts and Culture",
    url: "https://www.motac.gov.my/",
  },
  MZ: {
    country: "Mozambique",
    organisation: "INATUR — Visit Mozambique",
    url: "https://www.visitmozambique.gov.mz/",
  },
  NA: {
    country: "Namibia",
    organisation: "Namibia Tourism Board — Visit Namibia",
    url: "https://visitnamibia.com.na/",
  },
  NG: {
    country: "Nigeria",
    organisation: "Nigerian Tourism Development Authority — Tour Nigeria",
    url: "https://www.ntda.gov.ng/",
  },
  NI: {
    country: "Nicaragua",
    organisation: "Instituto Nicaragüense de Turismo",
    url: "https://www.intur.gob.ni/",
  },
  NL: {
    country: "Kingdom of the Netherlands",
    organisation: "NBTC Holland Marketing",
    url: "https://www.holland.com/",
  },
  NO: {
    country: "Norway",
    organisation: "Visit Norway (Innovation Norway)",
    url: "https://www.visitnorway.com/",
  },
  NP: {
    country: "Nepal",
    organisation: "Nepal Tourism Board",
    url: "https://ntb.gov.np/",
  },
  NZ: {
    country: "New Zealand",
    organisation: "Tourism New Zealand",
    url: "https://www.newzealand.com/",
  },
  OM: {
    country: "Oman",
    organisation: "Ministry of Heritage and Tourism — Experience Oman",
    url: "https://experienceoman.om/",
  },
  PA: {
    country: "Panama",
    organisation: "Autoridad de Turismo de Panama (ATP)",
    url: "https://www.visitpanama.com/",
  },
  PE: {
    country: "Peru",
    organisation: "Ministry of Foreign Commerce and Tourism",
    url: "https://www.mincetur.gob.pe/",
  },
  PG: {
    country: "Papua New Guinea",
    organisation: "PNG Tourism Promotion Authority",
    url: "https://papuanewguinea.travel/",
  },
  PH: {
    country: "Philippines",
    organisation: "Department of Tourism — Philippines",
    url: "https://www.itsmorefuninthephilippines.com/",
  },
  PK: {
    country: "Pakistan",
    organisation: "Pakistan Tourism Development Corporation",
    url: "https://tourism.gov.pk/",
  },
  PL: {
    country: "Poland",
    organisation: "Polish Tourism Organisation — Poland Travel",
    url: "https://www.poland.travel/en/",
  },
  PS: {
    country: "Palestine",
    organisation: "Ministry of Tourism and Antiquities",
    url: "https://tourism.ps",
  },
  PT: {
    country: "Portugal",
    organisation: "Turismo de Portugal — Visit Portugal",
    url: "https://www.visitportugal.com/en",
  },
  PW: {
    country: "Palau",
    organisation: "Palau Visitors Authority",
    url: "https://pristineparadisepalau.com/",
  },
  PY: {
    country: "Paraguay",
    organisation: "SENATUR — Secretaria Nacional de Turismo",
    url: "https://senatur.gov.py/",
  },
  QA: {
    country: "Qatar",
    organisation: "Qatar Tourism Authority",
    url: "https://www.visitqatar.qa",
  },
  RO: {
    country: "Romania",
    organisation: "Ministry of Tourism — Romania Travel",
    url: "https://www.romania.travel",
  },
  RS: {
    country: "Serbia",
    organisation: "National Tourism Organisation of Serbia",
    url: "https://www.serbia.travel/en/",
  },
  RU: {
    country: "Russia",
    organisation: "Russia.Travel — National Tourism Portal",
    url: "https://eng.russia.travel/",
  },
  RW: {
    country: "Rwanda",
    organisation: "Rwanda Development Board — Visit Rwanda",
    url: "https://www.visitrwanda.com/",
  },
  SA: {
    country: "Saudi Arabia",
    organisation: "Saudi Tourism Authority — Visit Saudi",
    url: "https://www.visitsaudi.com/en",
  },
  SB: {
    country: "Solomon Islands",
    organisation: "Tourism Solomons",
    url: "https://www.visitsolomons.com.sb/",
  },
  SC: {
    country: "Seychelles",
    organisation: "Ministry for Tourism and Culture",
    url: "https://tourism.gov.sc/",
  },
  SD: {
    country: "Sudan",
    organisation: "Sudan Ministry of Tourism",
    url: "https://www.sudan-tourism.gov.sd",
  },
  SE: {
    country: "Sweden",
    organisation: "Visit Sweden",
    url: "https://visitsweden.com/",
  },
  SG: {
    country: "Singapore",
    organisation: "Singapore Tourism Board",
    url: "https://www.visitsingapore.com/",
  },
  SI: {
    country: "Slovenia",
    organisation: "Slovenian Tourist Board",
    url: "https://www.slovenia.info/",
  },
  SK: {
    country: "Slovakia",
    organisation: "Slovakia.travel",
    url: "https://slovakia.travel/en",
  },
  SL: {
    country: "Sierra Leone",
    organisation: "Sierra Leone National Tourist Board",
    url: "https://portal.ntb.gov.sl/",
  },
  SM: {
    country: "San Marino",
    organisation: "Secretary for Tourism",
    url: "http://www.turismo.sm",
  },
  SN: {
    country: "Senegal",
    organisation: "Ministry of Tourism of Senegal",
    url: "http://www.tourisme.gouv.sn/",
  },
  SO: {
    country: "Somalia",
    organisation: "Ministry of Information, Culture and Tourism — Visit Somalia",
    url: "https://moi.gov.so/",
  },
  SS: {
    country: "South Sudan",
    organisation: "South Sudan MFA — tourism",
    url: "https://mofaic.gov.ss/tourism/",
  },
  ST: {
    country: "São Tomé and Príncipe",
    organisation: "Visit Sao Tome and Principe",
    url: "https://visitsaotomeprincipe.st/en",
  },
  SV: {
    country: "El Salvador",
    organisation: "Ministry of Tourism",
    url: "http://www.mitur.gob.sv/",
  },
  SY: {
    country: "Syria",
    organisation: "Syrian Ministry of Tourism",
    url: "https://mots.gov.sy/en/",
  },
  SZ: {
    country: "Eswatini",
    organisation: "Eswatini Tourism Authority",
    url: "https://www.thekingdomofeswatini.com/",
  },
  TG: {
    country: "Togo",
    organisation: "Togo Tourisme (Ministry of Tourism)",
    url: "https://www.togotourisme.tg/",
  },
  TH: {
    country: "Thailand",
    organisation: "Tourism Authority of Thailand",
    url: "https://www.tat.or.th/",
  },
  TJ: {
    country: "Tajikistan",
    organisation: "Committee for Tourism Development — Travel Tajikistan",
    url: "https://traveltajikistan.tj/en/home-en/",
  },
  TL: {
    country: "Timor-Leste",
    organisation: "Ministry of Tourism and Environment — Tourism Timor-Leste",
    url: "https://timorleste.tl/",
  },
  TM: {
    country: "Turkmenistan",
    organisation: "State Committee for Tourism of Turkmenistan",
    url: "http://tourism.gov.tm/",
  },
  TN: {
    country: "Tunisia",
    organisation: "Tunisian National Tourist Office",
    url: "http://www.discovertunisia.com/",
  },
  TO: {
    country: "Tonga",
    organisation: "Tonga Tourism Authority",
    url: "https://www.tongatourism.travel/",
  },
  TR: {
    country: "Turkey",
    organisation: "Türkiye Tourism Promotion and Development Agency — GoTürkiye",
    url: "https://goturkiye.com/",
  },
  TT: {
    country: "Trinidad and Tobago",
    organisation: "Visit Trinbago (Tourism Trinidad / Tobago)",
    url: "https://visittrinbago.tt/",
  },
  TV: {
    country: "Tuvalu",
    organisation: "Timeless Tuvalu (Government of Tuvalu)",
    url: "https://www.timelesstuvalu.com/",
  },
  TW: {
    country: "Taiwan",
    organisation: "Tourism Administration, MOTC",
    url: "https://www.taiwan.net.tw/",
  },
  TZ: {
    country: "Tanzania",
    organisation: "Tanzania Tourist Board",
    url: "https://www.tanzaniatourism.go.tz/",
  },
  UA: {
    country: "Ukraine",
    organisation: "Ukraine NOW",
    url: "https://ukraine.ua/",
  },
  UG: {
    country: "Uganda",
    organisation: "Uganda Tourism Board",
    url: "https://utb.go.ug/",
  },
  US: {
    country: "United States",
    organisation: "Brand USA — Visit The USA",
    url: "https://www.visittheusa.com/",
  },
  UY: {
    country: "Uruguay",
    organisation: "Ministerio de Turismo — Uruguay Natural",
    url: "https://uruguaynatural.com/en/",
  },
  UZ: {
    country: "Uzbekistan",
    organisation: "Uzbekistan Travel (Tourism Committee)",
    url: "https://uzbekistan.travel/en/",
  },
  VA: {
    country: "Vatican City",
    organisation: "Vatican Museums (Holy See)",
    url: "https://www.museivaticani.va/",
  },
  VC: {
    country: "Saint Vincent and the Grenadines",
    organisation: "SVG Tourism Authority — Discover SVG",
    url: "https://discoversvg.com/",
  },
  VE: {
    country: "Venezuela",
    organisation: "MINTUR — Ministerio del Poder Popular para el Turismo",
    url: "https://www.mintur.gob.ve/",
  },
  VN: {
    country: "Vietnam",
    organisation: "Vietnam National Authority of Tourism",
    url: "https://vietnamtourism.gov.vn/en",
  },
  VU: {
    country: "Vanuatu",
    organisation: "Vanuatu Tourism Office",
    url: "https://www.vanuatu.travel/en/",
  },
  WS: {
    country: "Samoa",
    organisation: "Samoa Tourism Authority",
    url: "https://www.samoa.travel/",
  },
  XK: {
    country: "Kosovo",
    organisation: "Kosovo Ministry of Industry, Entrepreneurship and Trade — Tourism Department",
    url: "https://mint.rks-gov.net/",
  },
  YE: {
    country: "Yemen",
    organisation: "Yemen Tourism Promotion Board / Ministry of Tourism",
    url: "https://yementourism.com/",
  },
  ZA: {
    country: "South Africa",
    organisation: "Department of Tourism",
    url: "http://www.tourism.gov.za",
  },
  ZM: {
    country: "Zambia",
    organisation: "Zambia Tourism Agency",
    url: "https://www.zambia.travel/",
  },
  ZW: {
    country: "Zimbabwe",
    organisation: "Zimbabwe Tourism Authority",
    url: "https://www.zimbabwetourism.net/",
  },
};

/** The official tourism site for a country code, if one is known. */
export function tourismSourceFor(countryCode: string | undefined): TourismSource | undefined {
  if (!countryCode) return undefined;
  return TOURISM_SOURCES[countryCode.trim().toUpperCase()];
}

/** Same, by English country name — what the search form actually collects. */
export function tourismSourceByName(country: string | undefined): TourismSource | undefined {
  const wanted = country?.trim().toLowerCase();
  if (!wanted) return undefined;
  for (const source of Object.values(TOURISM_SOURCES)) {
    if (source.country.toLowerCase() === wanted) return source;
  }
  // "Britain" for "United Kingdom", "Holland" for the Netherlands: accept a
  // name that is contained in the official one rather than returning nothing.
  if (wanted.length < 4) return undefined;
  for (const source of Object.values(TOURISM_SOURCES)) {
    const name = source.country.toLowerCase();
    if (name.includes(wanted) || wanted.includes(name)) return source;
  }
  return undefined;
}

/** The entry for a country code, falling back to its name. */
export function findTourismSource(
  countryCode: string | undefined,
  country?: string,
): TourismSource | undefined {
  return tourismSourceFor(countryCode) ?? tourismSourceByName(country);
}
