var map;
var markersArray = [];

var TileWMS = function (coord, zoom) {
    var WMS_URL = 'https://servicios.idee.es/wms-inspire/transportes?';
    var WMS_Layers = 'TN.RoadTransportNetwork.RoadLink,TN.RoadTransportNetwork.RoadServiceArea';
    var proj = map.getProjection();
    var zfactor = Math.pow(2, zoom);
    var top = proj.fromPointToLatLng(new google.maps.Point(coord.x * 256 / zfactor, coord.y * 256 / zfactor));
    var bot = proj.fromPointToLatLng(new google.maps.Point((coord.x + 1) * 256 / zfactor, (coord.y + 1) * 256 / zfactor));
    var bbox = top.lng() + "," + bot.lat() + "," + bot.lng() + "," + top.lat();

    var myURL = WMS_URL + "SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&SRS=EPSG%3A4326&WIDTH=256&HEIGHT=256&FORMAT=image/png&TRANSPARENT=TRUE";
    myURL += "&LAYERS=" + WMS_Layers;
    myURL += "&BBOX=" + bbox;
    return myURL;
}

var directionsDisplay;
var directionsService;
let myPosition;

function initMap() {
    let defaultCenter = new google.maps.LatLng(43.360664, -5.850464);
    initialize(defaultCenter);
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition((position => {
            setCenter(position.coords.latitude, position.coords.longitude);
        }));
    }
}

function getPrice(price) {
    if (price === "free") return "0,00";
    else if (price.includes("€")) {
        let pos = price.indexOf("€");
        return price.substring(pos - 4, pos);
    }
    else return price.trim().substring(0, 4);
}

function loadGoogleAutocomplete() {
    const inputOrigen = document.getElementById("inputOrigen");
    const inputDestino = document.getElementById("inputDestino");

    const spainBounds = new google.maps.LatLngBounds(
        new google.maps.LatLng(36.000, -10.000),
        new google.maps.LatLng(43.740, 4.330)
    );

    const options = {
        bounds: spainBounds,
        componentRestrictions: {country: "es"},
        fields: ["name"],
        strictBounds: false,
        types: ["address"]
    }

    new google.maps.places.Autocomplete(inputOrigen, options);
    new google.maps.places.Autocomplete(inputDestino, options);
}

function initialize(center) {
    loadGoogleAutocomplete();

    directionsDisplay = new google.maps.DirectionsRenderer({
        polylineOptions: {
            strokeColor: '#3282ea', // Color de la línea de la ruta
            strokeOpacity: 1.0,
            strokeWeight: 7 // Grosor de la línea de la ruta (ajústalo según tus necesidades)
        },
        suppressMarkers: true
    });
    directionsService = new google.maps.DirectionsService();

    var misOpciones = {
        zoom: 9,
        center: center,
        mapTypeId: google.maps.MapTypeId.ROADMAP,
        styles: estiloMapa
    };
    map = new google.maps.Map(document.getElementById("map_canvas"), misOpciones);
    myPosition = new google.maps.Marker({
        position: center,
        map: map,
        icon: "media/miPosicion.png",
    });
    myPosition.setZIndex(1000);

    setCenter(center);

    var overlayOptions =
    {
        getTileUrl: TileWMS,
        tileSize: new google.maps.Size(256, 256)
    };
    var overlayWMS = new google.maps.ImageMapType(overlayOptions);
    map.overlayMapTypes.push(overlayWMS);
    directionsDisplay.setMap(map);
    getCargadores().then(cargadores => cargadores.forEach(addMarcadorCargador));
}

function calcularRuta(e) {
    e.preventDefault();
    const start = e.target["inputOrigen"].value;
    const end = e.target["inputDestino"].value;
    const autonomia = parseInt(e.target["inputAutonomia"].value);
    const cargaBateria = parseFloat(e.target["inputBateria"].value) / 100;
    const peticion = {
        origin: start,
        destination: end,
        travelMode: google.maps.DirectionsTravelMode.DRIVING
    };

    directionsService.route(peticion, async function (response, status) {
        if (status !== google.maps.DirectionsStatus.OK) return;
        limpiarMarcadores();
        directionsDisplay.setDirections({routes: []});

        let rutaRestante = response.routes[0].overview_path;
        let cargaRestante = cargaBateria;
        const cargadores = [];

        while (rutaRestante.length > 0) {
            const datosMejorCargador = await getMejorCargador(rutaRestante, autonomia, cargaRestante);
            if (datosMejorCargador === null) {
                alert("No se ha encontrado una ruta");
                return;
            }

            rutaRestante = datosMejorCargador.rutaRestante;
            cargaRestante = datosMejorCargador.cargaRestante;
            if (datosMejorCargador.cargador !== null) {
                cargadores.push(datosMejorCargador.cargador);
            }
        }

        const peticionConCargadores = {
            origin: start,
            destination: end,
            waypoints: cargadores.map(({lat, lng}) => ({ location: new google.maps.LatLng(lat, lng) })),
            travelMode: google.maps.DirectionsTravelMode.DRIVING
        };

        directionsService.route(peticionConCargadores, async function (response, status) {
            if (status !== google.maps.DirectionsStatus.OK) return;
            directionsDisplay.setDirections(response);
        });
    });
    return false;
}

async function getMejorCargador(ruta, autonomia, cargaBateria) {
    const radioBusqueda = 15;
    const autonomiaRestante =  autonomia * cargaBateria;
    let dist = 0;
    let puntoParaBuscar = null;

    for (let i = 0; i < ruta.length - 1; i++) {
        dist += google.maps.geometry.spherical.computeDistanceBetween(ruta[i], ruta[i + 1]) / 1000;
        if (dist + radioBusqueda * 2 > autonomiaRestante) {
            puntoParaBuscar = i + 1;
            break;
        }
    }

    if (puntoParaBuscar === null) {
        return {
            rutaRestante: [],
            cargaRestante: autonomiaRestante - dist / autonomia,
            cargador: null
        };
    }

    let ultimaBusqueda = null;
    let cargadores = [];
    for (; puntoParaBuscar >= 0; puntoParaBuscar--) {
        const distUltimaBusqueda = ultimaBusqueda !== null ?
            google.maps.geometry.spherical.computeDistanceBetween(ruta[puntoParaBuscar], ultimaBusqueda) / 1000 :
            Infinity;
        if (puntoParaBuscar > 0 && distUltimaBusqueda < radioBusqueda) {
            continue;
        }

        ultimaBusqueda = ruta[puntoParaBuscar];
        cargadores = await getCargadores({
            distancia: radioBusqueda, 
            lat: ultimaBusqueda.lat(),
            lng: ultimaBusqueda.lng()
        });
        if (cargadores.length !== 0) break;
    }

    if (cargadores.length === 0) return null;

    const mejorCargador = cargadores.sort((a, b) => {
        if (a.PrecioCalculado !== b.PrecioCalculado) {
            return a.PrecioCalculado - b.PrecioCalculado;
        }
        return a.AddressInfo.Distance - b.AddressInfo.Distance;
    })[0];

    const marcador = addMarcadorCargador(mejorCargador);
    marcador.setIcon("media/electricidad_seleccionada.png");
    marcador.setVisible(true);

    return {
        rutaRestante: ruta.slice(puntoParaBuscar + 1),
        cargaRestante: 1 - (2 * mejorCargador.AddressInfo.Distance) / autonomia,
        cargador: {
            lat: mejorCargador.AddressInfo.Latitude, 
            lng: mejorCargador.AddressInfo.Longitude
        }
    };
}

const markers = new Map();

async function getCargadores(coordenadas = null) {
    const url = "https://api.openchargemap.io/v3/poi";
    let query = "statustypeid=50&usagetypeid=1,4,5,7&minpowerkw=100&maxresults=1000&countrycode=ES&camelcase=false&key=ee289fb2-57ea-453d-84ce-70d9906b84d9";
    if (coordenadas) {
        const {distancia, lat, lng} = coordenadas;
        query += `&latitude=${lat}&longitude=${lng}&distance=${distancia}&distanceunit=2`;
    }

    const res = await fetch(`${url}?${query}`);
    if (!res.ok) return;

    let data = await res.json();
    data = data.filter(element => element.UsageCost != "" && element.UsageCost != null)
    data.forEach(element => {
        const price = getPrice(element.UsageCost);
        element.PrecioCalculado = parseFloat(price.replace(',', '.'));
    });

    return data;
}

function addMarcadorCargador(cargador) {
    if (markers.has(cargador.ID)) return markers.get(cargador.ID);

    const marker = new google.maps.Marker({
        position: { lat: cargador.AddressInfo.Latitude, lng: cargador.AddressInfo.Longitude },
        map: map,
        icon: "media/electricidad.png",
    });

    ((marker, cargador) => {
        marker.addListener('click', () => {

            new google.maps.InfoWindow({
                content: '<h3>' + cargador.AddressInfo.Title + '</h3>' +
                    '<p>Dirección: ' + cargador.AddressInfo.AddressLine1 + '</p>' +
                    '<p>Precio: ' + cargador.PrecioCalculado + ' €/kWh</p>' +
                    '<p>Conexiones: <ul>' + cargador.Connections.map(conn => {
                        return '<li>' + conn.CurrentType?.Title + ' - ' + conn.PowerKW + 'kW</li>'
                    }) + '</ul></p>'
            }).open(map, marker);
        });
    })(marker, cargador);

    markers.set(cargador.ID, marker);
    return marker;
}

function limpiarMarcadores() {
    for (const marker of markers.values()) {
        if (marker.getIcon() !== "media/electricidad.png") {
            marker.setIcon("media/electricidad.png");
        }
        marker.setVisible(false);
    }
}

function setCenter(lat, lng) {
    const center = new google.maps.LatLng(lat, lng);
    map.setCenter(center);
    myPosition.setPosition(center);
    const geocoder = new google.maps.Geocoder();
    geocoder.geocode({location: center}, (results, status) => {
        if(status === google.maps.GeocoderStatus.OK && results[0])
        document.getElementById("inputOrigen").value = results[0].formatted_address;
    });
}