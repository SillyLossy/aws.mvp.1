# How to use
* Open console in repository. Type `npm i`
* Create `credentials.js` file in repository root with the following content:
```
exports.accessKey = 'your aws access key';
exports.secretKey = 'your aws secret key';
exports.region = 'your aws region';
```
* Type `node index.js`. The server will run on your local port `9000`
* Open `index.html` in your browser
