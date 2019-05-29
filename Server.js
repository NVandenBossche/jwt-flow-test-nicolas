// Load Express and other dependencies
var express = require("express"),
    http = require("http"),
    request = require("request"),
    bodyParser = require("body-parser"),
    morgan = require("morgan"),
    app = express(),
    path = require("path"),
    https = require("https"),
    fs = require("fs"),
    base64url = require("base64-url"),
    nJwt = require("njwt"),
    CryptoJS = require("crypto-js"),
    crypto = require("crypto"),
    apiVersion = "v45.0",
    domainName = "localhost:8081",
    clientId = process.env.CLIENT_ID,
    clientSecret = process.env.CLIENT_SECRET,
    callbackURL = process.env.CALLBACK_URL,
		baseURL = process.env.BASE_URL,
		username = process.env.USERNAME,
    jwt_aud = "https://login.salesforce.com",
    endpointUrl = "",
    state = "",
    refreshToken = "",
    webserverType = "";

// Set default view engine to ejs. This will be used when calling res.render()
app.set("view engine", "ejs");

// Let Express know where the client files are located
app.use(express.static(__dirname + "/client"));

// Setting up of app
app.use(morgan("dev"));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Set the port to use based on the environment variables
app.set("port", process.env.PORT);

/**
 * Extract Access token from POST response and redirect to page queryresult
 */
function accessTokenCallback(err, remoteResponse, remoteBody, res) {
    // Display error if error is returned to callback function
    if (err) {
        return res.status(500).end("Error");
    }

    console.log('Access token response:' + remoteBody);

    // Retrieve the response
    var sfdcResponse = JSON.parse(remoteBody);
		var identityUrl = sfdcResponse.id;
		var issuedAt = sfdcResponse.issued_at;
		
		// Check the signature
		if (identityUrl && issuedAt) {
			var hash = CryptoJS.HmacSHA256(
				identityUrl + issuedAt,
					clientSecret
			);
			var hashInBase64 = CryptoJS.enc.Base64.stringify(hash);
			if (hashInBase64 != sfdcResponse.signature) {
					return res
							.status(500)
							.end("Signature not correct - Identity cannot be confirmed");
			}
		}

		if(sfdcResponse.id_token) {
			// Decode ID token
			var idToken = sfdcResponse.id_token;
			
			var tokenSplit = idToken.split('.');
			var header = CryptoJS.enc.Base64.parse(tokenSplit[0]);
			var body = CryptoJS.enc.Base64.parse(tokenSplit[1]);

			console.log('ID Token header: ' + header.toString(CryptoJS.enc.Utf8));
			console.log('ID Token body: ' + body.toString(CryptoJS.enc.Utf8));
		}

    // In case no error and signature checks out, AND there is an access token present, store refresh token and redirect to query page
    if (sfdcResponse.access_token) {
        refreshToken = sfdcResponse.refresh_token;
        res.writeHead(302, {
            Location: "queryresult",
            "Set-Cookie": [
                "AccToken=" + sfdcResponse.access_token,
                "APIVer=" + apiVersion,
                "InstURL=" + sfdcResponse.instance_url,
                "idURL=" + sfdcResponse.id
            ]
        });
    } else {
        res.write(
            "Some error occurred. Make sure connected app is approved previously if its JWT flow, Username and Password is correct if its Password flow. "
        );
        res.write(" Salesforce Response : ");
        res.write(remoteBody);
    }
    res.end();
}

/**
 * Create a JWT client assertion
 * @returns JWT client assertion
 */
function createClientAssertion() {
	var assertionData = {
		iss: clientId,
		sub: clientId,
		aud: baseURL + '/services/oauth2/token',
		exp: Math.floor(new Date() / 1000) + 60*3
	};

	return encryptUsingPrivateKey_nJWTLib(assertionData);
}

/**
 * Function that generates a cryptographically random code verifier
 * @returns Cryptographically random code verifier
 */
function generateCodeVerifier() {
    return crypto
        .randomBytes(128)
        .toString("base64")
        .replace(/=/g, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");
}

/**
 * Function that hashes the code verifier and encodes it into base64URL
 * @param {String} verifier
 * @returns Code challenge based on provided verifier
 */
function generateCodeChallenge(verifier) {
    return CryptoJS.SHA256(verifier)
        .toString(CryptoJS.enc.Base64)
        .replace(/=/g, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");
}

function getJWTSignedToken_nJWTLib(sfdcUserName) {
	var claims = {
			iss: clientId,
			sub: sfdcUserName,
			aud: jwt_aud,
			exp: Math.floor(Date.now() / 1000) + 60 * 3
	};

	return encryptUsingPrivateKey_nJWTLib(claims);
}

function encryptUsingPrivateKey_nJWTLib(claims) {
	var absolutePath = path.resolve("key.pem");
	var cert = fs.readFileSync(absolutePath);
	
	var jwt_token = nJwt.create(claims, cert, "RS256");
	var jwt_token_b64 = jwt_token.compact();

	console.log('JWT Token: ' + jwt_token);
	
	return jwt_token_b64;
}

app.all("/proxy", function(req, res) {
    var url = req.header("SalesforceProxy-Endpoint");
    request({
        url: url,
        method: req.method,
        json: req.body,
        headers: {
            Authorization: req.header("X-Authorization"),
            "Content-Type": "application/json"
        },
        body: req.body
    }).pipe(res);
});

app.get("/jwt", function(req, res) {
    var token = getJWTSignedToken_nJWTLib(username);

    if (req.query.isSandbox == "true") {
        endpointUrl = "https://test.salesforce.com/services/oauth2/token";
    } else {
        endpointUrl = baseURL + "/services/oauth2/token";
    }

    var paramBody =
        "grant_type=" +
        base64url.escape("urn:ietf:params:oauth:grant-type:jwt-bearer") +
        "&assertion=" +
        token;
    var req_sfdcOpts = {
        url: endpointUrl,
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: paramBody
    };

    request(req_sfdcOpts, function(err, remoteResponse, remoteBody) {
        accessTokenCallback(err, remoteResponse, remoteBody, res);
    });
});

/**
 * Step 1 Web Server Flow - Get Code
 */
app.get("/webServer", function(req, res) {
    // Set parameter values based on environment variables
    var responseType = "code";
    var scope = "full%20refresh_token";
    webserverType = req.query.type;

    if (req.query.isSandbox == "true") {
        endpointUrl = "https://test.salesforce.com/services/oauth2/authorize";
        state = "webServerSandbox";
    } else {
        endpointUrl = baseURL + "/services/oauth2/authorize";
        state = "webServerProd";
    }

    var authorizationUrl =
        endpointUrl +
        "?client_id=" +
        clientId +
        "&redirect_uri=" +
        encodeURI(callbackURL) +
        "&response_type=" +
        responseType +
        "&state=" +
        state +
        "&scope=" +
        scope +
        "&code_challenge=" +
        codeChallenge;

    request({ url: authorizationUrl, method: "GET" }).pipe(res);
});

/**
 * Step 2 Web Server Flow - Get token from Code
 */
app.get("/webServerStep2", function(req, res) {
    var grantType = "authorization_code";
    var code = req.query.code;
    var state = req.query.state;

    if (state == "webServerSandbox") {
        endpointUrl = "https://test.salesforce.com/services/oauth2/token";
    } else {
        endpointUrl = baseURL + "/services/oauth2/token";
    }

    var tokenUrl =
        endpointUrl +
        "?client_id=" +
        clientId +
        "&redirect_uri=" +
        encodeURI(callbackURL) +
        "&grant_type=" +
        grantType +
        "&code=" +
        code +
        "&code_verifier=" +
        codeVerifier;

		if (webserverType == "secret") {
			tokenUrl += "&client_secret=" + clientSecret;
		}

    if (webserverType == "assertion") {
			tokenUrl += "&client_assertion=" + createClientAssertion();
			tokenUrl += "&client_assertion_type=" + "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
    }

    request({ url: tokenUrl, method: "POST" }, function(
        err,
        remoteResponse,
        remoteBody
    ) {
        accessTokenCallback(err, remoteResponse, remoteBody, res);
    });
});

/**
 *	 User Agent oAuth Flow
 */
app.get("/uAgent", function(req, res) {
    var isSandbox = req.query.isSandbox;

    if (isSandbox == "true") {
        endpointUrl = "https://test.salesforce.com/services/oauth2/authorize";
    } else {
        endpointUrl = baseURL + "/services/oauth2/authorize";
    }

    request({
        url:
            endpointUrl +
            "?client_id=" +
            process.env.CLIENT_ID +
            "&redirect_uri=" +
            process.env.CALLBACK_URL +
            "&response_type=token",
        method: "GET"
    }).pipe(res);
});

/**
 *	 Username Password oAuth Flow
 */
app.post("/uPwd", function(req, res) {
    var instance = req.body.instance;
    var uname = req.body.sfdcUsername;
    var pwd = req.body.sfdcPassword;
    var state = req.query.state;

    if (instance == "sand") {
        endpointUrl = "https://test.salesforce.com/services/oauth2/token";
    } else {
        endpointUrl = baseURL + "/services/oauth2/token";
    }

    var computedURL =
        endpointUrl +
        "?client_id=" +
        clientId +
        "&grant_type=password" +
        "&client_secret=" +
        clientSecret +
        "&username=" +
        uname +
        "&password=" +
        pwd;

    request({ url: computedURL, method: "POST" }, function(
        err,
        remoteResponse,
        remoteBody
    ) {
        accessTokenCallback(err, remoteResponse, remoteBody, res);
    });
});

/**
 * Device Authentication Flow
 */
app.get("/device", function(req, res) {
    if (req.query.isSandbox == "true") {
        endpointUrl = "https://test.salesforce.com/services/oauth2/token";
    } else {
        endpointUrl = baseURL + "/services/oauth2/token";
    }

    var computedURL =
        endpointUrl + "?client_id=" + clientId + "&response_type=device_code";

    request({ url: computedURL, method: "POST" }, function(
        err,
        remoteResponse,
        remoteBody
    ) {
        if (err) {
            res.write(err);
            res.end();
            //return res.status(500).end('Error');
            return;
        }
        console.log(remoteBody);
        var sfdcResponse = JSON.parse(remoteBody);

        if (sfdcResponse.verification_uri) {
            res.render("deviceOAuth", {
                verification_uri: sfdcResponse.verification_uri,
                user_code: sfdcResponse.user_code,
                device_code: sfdcResponse.device_code,
                isSandbox: req.query.isSandbox
            });
        }
    });
});

/**
 *  Keep polling till device is verified using code
 */
app.get("/devicePol", function(req, res) {
    var verification_uri = req.query.verification_uri;
    var user_code = req.query.user_code;
    var device_code = req.query.device_code;

    if (req.query.isSandbox == "true") {
        endpointUrl = "https://test.salesforce.com/services/oauth2/token";
    } else {
        endpointUrl = baseURL + "/services/oauth2/token";
    }

    var computedURL =
        endpointUrl +
        "?client_id=" +
        clientId +
        "&grant_type=device" +
        "&code=" +
        device_code;

    request({ url: computedURL, method: "POST" }, function(
        err,
        remoteResponse,
        remoteBody
    ) {
        if (err) {
            return res.status(500).end("Error");
        }
        console.log(remoteBody);
        var sfdcResponse = JSON.parse(remoteBody);

        if (sfdcResponse.access_token) {
            res.writeHead(302, {
                Location: "queryresult",
                "Set-Cookie": [
                    "AccToken=" + sfdcResponse.access_token,
                    "APIVer=" + apiVersion,
                    "InstURL=" + sfdcResponse.instance_url,
                    "idURL=" + sfdcResponse.id
                ]
            });
            res.end();
        } else {
            res.render("deviceOAuth", {
                verification_uri: verification_uri,
                user_code: user_code,
                device_code: device_code,
                isSandbox: req.query.isSandbox
            });
        }
    });
});

app.route(/^\/(index.*)?$/).get(function(req, res) {
	res.render("index", {
			callbackURL: callbackURL,
            baseURL: baseURL,
            username: username,
			clientId: clientId,
			clientSecret: clientSecret,
			codeVerifier: codeVerifier,
			codeChallenge: codeChallenge
	});
});

app.get("/oauthcallback", function(req, res) {
	var code = req.query.code;
	var returnedState = req.query.state;

	res.render("oauthcallback", {
			code: code,
			returnedState: returnedState,
			originalState: state
	});
});

app.get("/queryresult", function(req, res) {
	res.render("queryresult");
});

app.listen(app.get("port"), function() {
	console.log("Express server listening on port " + app.get("port"));
});

// Load files with keys and options
var options = {
    key: fs.readFileSync("./key.pem", "utf8"),
    cert: fs.readFileSync("./server.crt", "utf8")
};

// Define code verifier and code challenge
var codeVerifier = generateCodeVerifier();
var codeChallenge = generateCodeChallenge(codeVerifier);

// Create the server and log that it's up and running
https.createServer(options, app).listen(8081);
console.log("Server listening for HTTPS connections on port ", 8081);
