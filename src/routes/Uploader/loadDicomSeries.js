'use strict';

import decompressDicomSerie from '../../scripts/decompressDicomSerie.js'
import cornerstoneImageToBase64 from '../../scripts/cornerstoneImageToBase64'

/*

  Given a FileList object containing DICOM files, will parse them,
  organize them into series and parse some metadata for them.

*/

export default function loadDicomSeries (files, progressCb) {

  progressCb = _.isFunction(progressCb) ? progressCb : function(){};

  let counter = 0;
  let total = files.length;

  window.dicomFiles = {};

  // First step: convert the jQuery Deferred objects cornerstone.loadImage()
  // returns into normal promises that will always resolve, either
  // with the processed image or with a falsy value if processing failed.
  // Also implement progress function here because that's the intensive part.

  let loadImagePromises = Array.prototype.map.call(files, file => new Promise(res => {

    let imageId = cornerstoneWADOImageLoader.fileManager.add(file);
    
    window.dicomFiles[imageId] = file;

    cornerstone.loadImage(imageId, false).then(image => {

      counter++;
      progressCb( counter / total );
      res(image);

    }).fail((e) => {

      console.log('Error while loading file ' + file.name + ': ' + e);
      total--;
      progressCb( counter / total );
      res(false);

    });

  }));

  // Second step: wait for all the converted promises to resolve, then
  // organize the parsed slices into series and extract metadata from them.

  return new Promise(res => {

    Promise.all(loadImagePromises).then(images => {
      
      // Prepare the series object that will mutate into an array (see below)
      let seriesObject = {};

      // Populate series object { UIDa: [images*], UIDb: [images*], etc... }
      _.each(_.compact(images), image => {

        let UID = image.data.string('x0020000e');

        seriesObject[UID] = seriesObject[UID] || [];
        seriesObject[UID].push(image);

      });
      
      for (let uid of Object.keys(seriesObject)) {
        console.log(uid)
        seriesObject[uid] = sortSerieSlices(seriesObject[uid])
      }

      // Convert to array [{ UID: 'UIDa', slices: [images]*}, etc...]
      // and add shared serie metadata while we're at it
      let seriesArray = _.reduce(seriesObject, (m, v, k) => {

        // Take description from first slice. It should be the same
        // everywhere anyways
        m.push({
          UID: k,
          slices: v,
          description: v[0].data.string('x0008103e')
        });

        return m;

      }, []);

      Promise.all(seriesArray.map(serie => new Promise(res => {

        let sliceIndex = Math.floor(serie.slices.length / 2);
        let slice = serie.slices[sliceIndex];
        let transferSyntax = slice.data.string('x00020010');

        if (transferSyntax == '1.2.840.10008.1.2.4.90') {
          // to FIX this is JPEG
          var file = window.dicomFiles[slice.imageId];
          let imageId = cornerstoneWADOImageLoader.fileManager.add(file);
          
          cornerstone.loadImage(imageId, true).then(image => {
            
            serie.thumbnail = cornerstoneImageToBase64(image);
            res(serie);
            
          });

        } else {

          // Generate thumbnail from middle slice
          serie.thumbnail = cornerstoneImageToBase64(slice);
          res(serie);

        }


      }))).then(res);

    })

  })

}

function sortSerieSlices (serieSlicesArray) {
  
  // Get rid of "cover" images generated by PACS, which don't belong in the current series. 
  // This is typically a single coronal slice at the 1st position in the axial series.
  if (serieSlicesArray.length > 2) {
  
    let firstSliceOrient = serieSlicesArray[0].data.string('x00200037')
    let secondSliceOrient = serieSlicesArray[1].data.string('x00200037')
    
    if (firstSliceOrient != secondSliceOrient) {
        serieSlicesArray = serieSlicesArray.splice(1)
        console.log('Eliminating unwanted cover slice')
    }
      
  }
  
  // Get the length AFTER we may have removed an element
  let slicesLength = serieSlicesArray.length;
  
  // Get the image orientation and patient position from any slice
  let firstSliceData = serieSlicesArray[0].data
 
  let imageOrientationPatient = firstSliceData.string('x00200037')
  
  if (imageOrientationPatient == undefined) {
    console.log(imageOrientationPatient)
  } else {
    imageOrientationPatient = imageOrientationPatient.split('\\')
  }
  
  let patientPosition = firstSliceData.string('x00185100')
  
  // Calculate Z vector by cross product of X and Y vectors
  let u = [parseFloat(imageOrientationPatient[0]), 
           parseFloat(imageOrientationPatient[1]), 
  	       parseFloat(imageOrientationPatient[2])]
  
  let v = [parseFloat(imageOrientationPatient[3]), 
           parseFloat(imageOrientationPatient[4]),
  	       parseFloat(imageOrientationPatient[5])]
  
  var ab = [u[1]*v[2] - u[2]*v[1], 
            u[2]*v[0] - u[0]*v[2], 
            u[0]*v[1] - u[1]*v[0] ];
  
  // Parse out imagePositionPatient for each slice
  let ipp = []
            
  for (let i = 0; i < slicesLength; i++) {
    
    let data = serieSlicesArray[i].data
		let imagePositionPatient = data.string('x00200032')
		let pos = imagePositionPatient.split('\\')
    
		ipp[i] = [parseFloat(pos[0]), 
              parseFloat(pos[1]), 
              parseFloat(pos[2])]
    
  }
    
  // Sort slices by scalar product between vector and position
  // which gives the distance along the Z vector
  let distances = []

  for (let i = 0; i < slicesLength; i++) {
    
    distances[i] = ipp[i][0] * ab[0] + 
    					     ipp[i][1] * ab[1] +
    						   ipp[i][2] * ab[2]
  
  }
  
  let sortedSerieSlices = distances
    .map(function(e,i){ return i; })
    .sort(function(a,b){ return distances[b] - distances[a]; })
    .map(function(e){ return serieSlicesArray[e]; })
  
  // Reverse order if feet first (default is head first)
  if (patientPosition == "FFDR" || patientPosition == "FFDL" || 
      patientPosition == "FFP" ) { //|| patientPosition == "FFS" ) {
    //alert(patientPosition)
		sortedSerieSlices = sortedSerieSlices.reverse()
	}

  return sortedSerieSlices
  
}
